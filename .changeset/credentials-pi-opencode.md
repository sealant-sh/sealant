---
"@sealant/sdk": minor
"@sealant/api-contracts": minor
---

pi's and opencode's ChatGPT logins are providers of `workspace.credentials`:

- `put({ …, pi, opencode })` names one of the person's Codex accounts (`true` is their default) and
  writes its ChatGPT login, with no refresh token, as one entry of each tool's own `auth.json`:
  `openai-codex` in `<home>/.pi/agent/auth.json`, `openai` in
  `<home>/.local/share/opencode/auth.json`. The file is merged in place as the home's owner, through
  links to where it really is, which must be inside the home and outside `/workspace`. Its other
  entries stay, and a login the person made inside pi or opencode is never replaced or removed.
- The home's record and `list()` name the Codex account under `pi` and `opencode`; `null` or a
  release removes only Core's copy, and a refresh of the Codex login rewrites both entries.
- A Codex account that is not a ChatGPT login is refused with `409` `connected-account-unsupported`
  and `provider: "codex"`.
- A first put refused because a login would land outside the home (`home-unusable`) no longer leaves
  its hold's marker behind: the home can be put into again without a release first.
