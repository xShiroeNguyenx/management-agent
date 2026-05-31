# Agent Manager

[![CI](https://github.com/xShiroeNguyenx/management-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/xShiroeNguyenx/management-agent/actions/workflows/ci.yml)
[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/shiroenguyen.management-agent?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=shiroenguyen.management-agent)
[![Open VSX](https://img.shields.io/open-vsx/v/shiroenguyen/management-agent?label=Open%20VSX)](https://open-vsx.org/extension/shiroenguyen/management-agent)

A small VS Code extension to **save and switch between multiple agent CLI accounts**
(Claude, Codex). Each profile takes a local snapshot of that tool's credentials, so you
can flip between, say, a work account and a personal account without logging in and out
every time. It also lets you pick which GitHub account this extension uses.

> Extracted from the *Agent Accounts* feature of the Anime Companion extension and
> repackaged as a standalone extension.

## How it works

- A **profile** is a snapshot of one tool's credentials stored in the extension's global
  storage at `agent-profiles/<id>/snapshot/`.
- **Save** captures the tool's current credentials into a new profile.
- **Use** backs up the credentials currently live (kept as `.backup-<tool>-<timestamp>`,
  max 3) and then restores the chosen profile's snapshot into the live location.
- The status bar shows which saved profile matches the credentials currently live.

### Supported tools

| Tool | Where credentials live | How it's swapped |
|------|------------------------|------------------|
| Claude | `~/.claude` (`.credentials.json` …) | copy credential files |
| Codex  | `~/.codex/auth.json` | copy credential files |
| GitHub | VS Code auth (keychain) | sets which signed-in account *this extension* uses (see note) |

> **GitHub/Copilot note:** this only sets the GitHub account *this extension's own* sessions
> use, stored globally. It does **not** change GitHub Copilot (a separate extension), git's
> commit identity, or any other extension. Since this extension makes no GitHub calls of its
> own, the choice is currently cosmetic — included for parity with the original.

## Commands

Open the Command Palette (`Ctrl+Shift+P`) and type **Agent Accounts**:

- **Agent Accounts: Manage…** — open the webview panel (save / use / rename / delete).
- **Agent Accounts: Save Current As…** — snapshot the current session as a new profile.
- **Agent Accounts: List** — quick list of saved profiles.
- **Agent Accounts: Quick Switch…** — quick-pick to switch the active profile / GitHub account
  (also the status bar click action).
- **Agent Accounts: Delete…** — delete a saved profile (snapshot only — live credentials untouched).
- **Agent Accounts: Switch GitHub Account…** — pick which GitHub account this extension uses.

## Develop

```bash
npm install
npm run compile      # tsc -> out/
```

Press **F5** in VS Code to launch an Extension Development Host.

Packaging needs **Node 20+** (`@vscode/vsce` no longer runs on Node 18):

```bash
npm run package      # -> management-agent-<version>.vsix
```

See [RELEASING.md](RELEASING.md) for the full release / CI/CD process.

## ⚠️ Note

Switching a profile **overwrites the real credentials** in `~/.claude` / `~/.codex`.
The extension automatically backs up the live credentials before each switch (last 3 kept),
but restart any running CLI sessions afterward so they pick up the new credentials.
