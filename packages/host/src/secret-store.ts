export type SecretEntry = {
  id: string;
  scope: 'user' | 'project';
  service: string;
  hint: string;
  configured: boolean;
  updatedAt: number;
};

export type SecretStore = {
  list(scope?: 'user' | 'project'): SecretEntry[];
  has(id: string, scope?: 'user' | 'project'): boolean;
  set(input: { id: string; value: string; scope?: 'user' | 'project'; service?: string }): SecretEntry;
  delete(id: string, scope?: 'user' | 'project'): boolean;
  /* reveal the raw value of a secret. host-side only — must not be exposed
     across the renderer/MCP boundary without explicit user confirmation. */
  reveal(id: string, scope?: 'user' | 'project'): string | null;
  onChange(listener: () => void): () => void;
};

const POLYPORE_SECRET_PREFIX = 'polypore.secret.';

/* fixed-width mask. value length is not a side-channel, and the renderer
   never has a reason to display anything that hints at the secret bytes. */
function mask(_value: string) {
  return '********';
}

function entryFromMeta(meta: { id: string; scope: 'user' | 'project'; service: string; hint: string; updatedAt: number }): SecretEntry {
  return { ...meta, configured: true };
}

function scopedKey(id: string, scope: 'user' | 'project') {
  return `${scope}:${id}`;
}

/* in-memory store. real Tauri shell swaps this for an OS-keyring binding;
   the M4 renderer-only build keeps the value in a per-tab Map plus
   metadata persistence so reloading the renderer doesn't lose the mask. */
export function createMemorySecretStore(): SecretStore {
  const meta = new Map<string, { id: string; scope: 'user' | 'project'; service: string; hint: string; updatedAt: number }>();
  const values = new Map<string, string>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const fn of [...listeners]) {
      try { fn(); } catch {}
    }
  };

  return {
    list(scope) {
      const items = [...meta.values()].map(entryFromMeta);
      return scope ? items.filter((entry) => entry.scope === scope) : items;
    },
    has(id, scope) {
      if (scope) return values.has(scopedKey(id, scope));
      return values.has(scopedKey(id, 'user')) || values.has(scopedKey(id, 'project'));
    },
    set({ id, value, scope = 'user', service }) {
      const key = scopedKey(id, scope);
      const next = {
        id,
        scope,
        service: service ?? id.split('-')[0] ?? id,
        hint: mask(value),
        updatedAt: Date.now(),
      };
      meta.set(key, next);
      values.set(key, value);
      notify();
      return entryFromMeta(next);
    },
    delete(id, scope) {
      const keys = scope ? [scopedKey(id, scope)] : [scopedKey(id, 'user'), scopedKey(id, 'project')];
      let had = false;
      for (const key of keys) {
        had = meta.delete(key) || had;
        values.delete(key);
      }
      if (had) notify();
      return had;
    },
    reveal(id, scope) {
      if (scope) return values.get(scopedKey(id, scope)) ?? null;
      return values.get(scopedKey(id, 'user')) ?? values.get(scopedKey(id, 'project')) ?? null;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/* localStorage-backed store. plaintext values still live in the renderer's
   per-origin localStorage — fine for the renderer-only M4 milestone where
   no native shell exists, replaced by a keyring binding once Tauri lands. */
export function createLocalStorageSecretStore(storage: StorageLike): SecretStore {
  const memory = createMemorySecretStore();

  try {
    const raw = storage.getItem(`${POLYPORE_SECRET_PREFIX}index`);
    if (raw) {
      const parsed = JSON.parse(raw) as Array<{ id: string; scope: 'user' | 'project'; service: string; hint: string; updatedAt: number }>;
      for (const item of parsed) {
        const valueRaw = storage.getItem(`${POLYPORE_SECRET_PREFIX}value.${item.scope}.${item.id}`)
          ?? storage.getItem(`${POLYPORE_SECRET_PREFIX}value.${item.id}`);
        if (valueRaw == null) continue;
        memory.set({ id: item.id, value: valueRaw, scope: item.scope, service: item.service });
      }
    }
  } catch {
    /* corrupt storage falls back to empty in-memory state */
  }

  const persistIndex = () => {
    const items = memory.list().map((entry) => ({
      id: entry.id,
      scope: entry.scope,
      service: entry.service,
      hint: entry.hint,
      updatedAt: entry.updatedAt,
    }));
    try {
      storage.setItem(`${POLYPORE_SECRET_PREFIX}index`, JSON.stringify(items));
    } catch {}
  };

  memory.onChange(persistIndex);

  return {
    list: memory.list,
    has: memory.has,
    set(input) {
      const entry = memory.set(input);
      try {
        storage.setItem(`${POLYPORE_SECRET_PREFIX}value.${entry.scope}.${entry.id}`, input.value);
      } catch {}
      return entry;
    },
    delete(id, scope) {
      const removed = memory.delete(id, scope);
      const scopes = scope ? [scope] : ['user', 'project'] as const;
      try {
        for (const itemScope of scopes) storage.removeItem(`${POLYPORE_SECRET_PREFIX}value.${itemScope}.${id}`);
        storage.removeItem(`${POLYPORE_SECRET_PREFIX}value.${id}`);
      } catch {}
      return removed;
    },
    reveal: memory.reveal,
    onChange: memory.onChange,
  };
}

/* Parse a .env file body into entries and load them into the store. Keys
   already present are not overwritten (manual entries win over .env discovery).
   Returns the list of newly-loaded handles. Tolerant of common .env quirks:
   blank lines, # comments, KEY=VALUE, KEY="VALUE", KEY='VALUE', export prefix. */
export function loadDotEnvIntoStore(body: string, store: SecretStore, opts?: { scope?: 'user' | 'project'; service?: string }): string[] {
  const scope = opts?.scope ?? 'project';
  const service = opts?.service;
  const loaded: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!key || !value) continue;
    const id = key.toLowerCase().replace(/_/g, '-');
    if (store.has(id, scope) || store.has(id)) continue;
    /* polypore handles are kebab-case; the original env-var name is preserved
       in the service field so the scrubbed env can re-emit it as a handle. */
    store.set({ id, value, scope, service: service ?? key });
    loaded.push(key);
  }
  return loaded;
}
