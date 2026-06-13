import { useEffect, useRef, useState } from 'react';

export interface HostInputBoxOverlayProps {
  prompt: string;
  placeholder?: string;
  initialValue?: string;
  /* mask the input and submit it verbatim — used for credential prompts
     (SSH key passphrases, HTTPS secrets) where trimming would corrupt the
     value the caller typed. */
  secret?: boolean;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}

export function HostInputBoxOverlay({ prompt, placeholder, initialValue, secret, onCancel, onSubmit }: HostInputBoxOverlayProps) {
  const [value, setValue] = useState(initialValue ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const submit = () => {
    const next = secret ? value : value.trim();
    if (!next) return;
    onSubmit(next);
  };

  return (
    <div className="panel-settings-backdrop" role="presentation">
      <div className="panel-settings-overlay host-input-overlay" role="dialog" aria-label={prompt}>
        <header>
          <strong>{prompt}</strong>
        </header>
        <input
          ref={inputRef}
          type={secret ? 'password' : 'text'}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            if (e.key === 'Escape') onCancel();
          }}
          aria-label={prompt}
        />
        <div className="host-confirm-overlay__actions">
          <button type="button" onClick={onCancel}>cancel</button>
          <button type="button" onClick={submit}>ok</button>
        </div>
      </div>
    </div>
  );
}
