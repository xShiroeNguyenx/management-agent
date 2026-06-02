# Changelog

All notable changes to **Agent Manager** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
