---
title: secrets & safety
group: the agent & mcp
order: 3
---

Polypore manages secrets so agents and tools can *use* them without making the
raw value part of normal chat context. This is the rule everything else follows:
**do not paste, print, commit, or summarize a secret value.**

## how it works

Stored secrets are represented in the UI and MCP tools as **handles**: an id,
scope, service label, and fixed-width mask. The raw value stays in the host
secret store. In the desktop shell, writes and reveals go through the OS
keyring; renderer-only/browser mode falls back to local in-process storage for
development.

When the native agent runner starts a Codex or Claude process, Polypore can
scrub keys discovered in `.env`, `.env.local`, and `.env.development` from the
child environment. It replaces them with variables of the form
`POLYPORE_SECRET_HANDLE_<KEY>=<handle>` and sets
`POLYPORE_AGENT_SCRUBBED=1`. The chat terminal path is a real pty and should be
treated like a normal shell unless that breadcrumb is present.

To use a stored secret without revealing it, an agent calls
`polypore.secrets.use` with the handle and a request (url, method, headers,
body). Polypore substitutes `${secret}` inside that outbound request, requires
HTTPS unless `allow_insecure` is explicit, and scrubs the secret value from
response headers/body before returning the result.

## what you do

- **add keys** in [settings → credentials](the-ide/settings) or the [agent panel](panels/polypore.agent)'s secrets rail.
  They're stored in the OS keyring when the desktop shell is present, with a
  local fallback otherwise.
- **check, don't reveal.** `polypore.secrets.has` and the credentials panel tell
  you whether a key is configured, never what it is.
- **scope deliberately.** `project` secrets are tied to the active project;
  `user` secrets are available across projects.
- **let `.env` discovery seed handles.** In the desktop shell, Polypore scans
  common `.env` files and creates handles for keys that are not already stored.
- **if a handle is missing,** add the key through credentials. Don't paste a
  secret into chat; it would be recorded there.

## what the agent must not do

- never `cat .env*`, `printenv`, or `env | grep` to fish for a value. If the
  native scrub breadcrumb is present, use the provided handle. If it is not
  present, still treat secret-shaped files and env vars as off-limits.
- never write a secret to a file or echo it into chat.
- when a needed handle doesn't exist, stop and ask for it to be added through the
  credentials panel rather than working around the policy.
