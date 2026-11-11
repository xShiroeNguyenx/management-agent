# Changelog

All notable changes to **Agent Manager** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-11

### Added
- **Auto-Yes** — a status bar button that lets Claude Code approve tool prompts on its
  own for a limited time. It registers a `PreToolUse` hook in Claude Code's
  `settings.json` the first time it is turned on, and switches itself off after
  `agentMgr.autoYes.hours` (default 24). New commands **Toggle Auto-Yes** and
  **Uninstall Auto-Yes Hook**.
- **Live Usage** — an opt-in status bar item showing the 5-hour / 7-day limits and the
  context percentage of the running Claude Code session, fed by a status line bridge.
  New command **Toggle Live Usage (status line)**.

### Fixed
- **Switching Claude accounts now works on macOS.** Claude Code keeps its login in the
  macOS Keychain there, not in `~/.claude/.credentials.json`, so saving a profile
  captured only settings files and switching changed nothing. Profiles are now saved
  from and restored to the Keychain, and the write is read back to confirm the swap
  really happened.
- Claude Code now shows the right email and organisation after a switch. That
  information lives in the `oauthAccount` field of `~/.claude.json`, which was left
  pointing at the previous account; it is now saved with each profile and put back on
  switch (only that field — the rest of the file is untouched).
- Saving a profile is refused when no login is found, and switching to a profile that
  holds no login now fails with a clear message, instead of reporting a success that
  changed nothing.

### Upgrade notes
- **macOS:** Claude profiles saved with earlier versions contain no login. Log in to
  each account and run **Agent Accounts: Save Current As…** again; switching to an
  old profile now says so instead of silently doing nothing. macOS may ask once for
  Keychain access.
- Profiles saved with earlier versions (any OS) still switch the login but carry no
  account info, so the displayed email stays stale until the profile is saved again.
- macOS: a login larger than about 2 KB (for example one carrying MCP OAuth tokens)
  cannot be switched yet, and a custom `CLAUDE_CONFIG_DIR` is not supported.

## [0.2.3] - 2026-06-03

### Fixed
- Switching accounts repeatedly no longer logs them out. Agent CLIs rotate their
  OAuth refresh token on use, so the snapshot captured at save time went stale and
  the server later rejected it — swapping away and back restored a dead token and
  forced a re-login (eventually across all accounts). Switching now syncs the live,
  rotated credentials back into the profile they belong to before overwriting them,
  keyed off an explicitly tracked per-tool active profile (so org-less Claude
  accounts, whose signature derives from the rotating token, are covered too).

## [0.2.2] - 2026-06-02

### Fixed
- Claude accounts without an `organizationUuid` (some team/SSO logins) no longer
  show blank in the Agent Accounts panel — identity now displays `sub`/expiry and
  falls back to a refresh-token signature for active detection.

## [0.2.1] - 2026-05-31

### Added
- Extension icon.

### Changed
- Release readiness: bundled `LICENSE`, `repository`/`bugs`/`homepage` metadata, CI/CD
  workflows (build + tag-driven publish to VS Marketplace and Open VSX), and a
  `RELEASING.md` guide. No functional change to the account-switching behavior.

## [0.2.0] - 2026-05-31

### Added
- **GitHub account switching** — pick which signed-in GitHub account this extension
  uses for its own sessions. New command **Agent Accounts: Switch GitHub Account…**
  and a GitHub section in the Agent Accounts panel.

### Notes
- Antigravity support was prototyped during this cycle but **not shipped**: the current
  "Antigravity IDE" build stores its login as an opaque protobuf OAuth token (no email in
  the state DB) and the account cannot be switched from within the running IDE. See
  `PLAN.md` for the full investigation.

## [0.1.0] - 2026-05-30

### Added
- Initial release. Save and switch between multiple **Claude** and **Codex** CLI accounts
  by snapshotting each tool's credential files into the extension's global storage.
- Agent Accounts webview panel (save / use / rename / delete).
- Status bar item showing the active account, click to quick-switch.
- Commands: Manage, Save Current As…, List, Quick Switch…, Delete.
- Automatic backup of live credentials before each switch (last 3 kept per tool).

[0.2.1]: https://github.com/xShiroeNguyenx/management-agent/releases/tag/v0.2.1
[0.2.0]: https://github.com/xShiroeNguyenx/management-agent/releases/tag/v0.2.0
[0.1.0]: https://github.com/xShiroeNguyenx/management-agent/releases/tag/v0.1.0
