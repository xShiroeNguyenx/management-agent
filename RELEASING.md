# Releasing Agent Manager

This project ships to the **VS Code Marketplace** and **Open VSX**, and attaches the
`.vsix` to a **GitHub Release**. Most of this is automated by
[`.github/workflows/release.yml`](.github/workflows/release.yml) — you just push a tag.

> ⚠️ **Node 20+ required.** `@vscode/vsce` no longer runs on Node 18 (it pulls `undici`,
> which throws `ReferenceError: File is not defined` on Node < 20). The CI/release
> workflows pin Node 20; locally, use `nvm use 20` (or newer) before packaging.

---

## 1. One-time setup

### a. Publishers
- **VS Marketplace:** create/own the publisher `shiroenguyen` at
  <https://marketplace.visualstudio.com/manage>. Backed by an Azure DevOps org.
- **Open VSX:** create a namespace `shiroenguyen` at <https://open-vsx.org> and sign the
  publisher agreement.

### b. Personal Access Tokens (PATs)
- **`VSCE_PAT`** — Azure DevOps PAT with **Marketplace → Manage** scope
  (<https://dev.azure.com> → User settings → Personal access tokens).
- **`OVSX_PAT`** — Open VSX access token (<https://open-vsx.org> → user settings → Access Tokens).

### c. Add the PATs as GitHub repo secrets
`Settings → Secrets and variables → Actions → New repository secret`:
| Secret | Value |
|--------|-------|
| `VSCE_PAT` | the Azure DevOps Marketplace PAT |
| `OVSX_PAT` | the Open VSX token |

> The release workflow **auto-skips** the Marketplace / Open VSX publish step if the matching
> secret is missing — so it still builds the `.vsix` and the GitHub Release without them.

---

## 2. Cut a release

1. Make sure `main` is green (CI passed) and your working tree is clean.
2. Update [`CHANGELOG.md`](CHANGELOG.md): add a section for the new version.
3. Bump the version **and** create the tag in one step:
   ```bash
   npm version patch   # 0.2.0 -> 0.2.1   (use: patch | minor | major | <exact>)
   git push --follow-tags
   ```
   `npm version` rewrites `package.json`, commits it, and creates a `vX.Y.Z` tag.
4. The push of the `vX.Y.Z` tag triggers **Release**, which:
   - verifies the tag matches `package.json` version,
   - lints + compiles + packages the `.vsix`,
   - creates the GitHub Release with the `.vsix` attached,
   - publishes to VS Marketplace (`VSCE_PAT`) and Open VSX (`OVSX_PAT`) if set.
5. Watch it under the repo's **Actions** tab.

---

## 3. Manual release (fallback, no CI)

From a clean checkout on **Node 20+**:
```bash
npm ci
npm run lint
npm run compile
npm run package                       # -> management-agent-<version>.vsix

# publish (needs the PATs in your shell)
npx @vscode/vsce publish -p "$VSCE_PAT"
npx ovsx publish ./*.vsix -p "$OVSX_PAT"
```
Install a built `.vsix` locally to smoke-test:
```bash
code --install-extension ./management-agent-<version>.vsix --force
```

---

## 4. Versioning

Semantic Versioning:
- **patch** — bug fixes, no behavior change.
- **minor** — new backend / command / capability, backward compatible.
- **major** — breaking changes (e.g. dropping a backend or changing stored profile shape).

## 5. Pre-release checklist
- [ ] `CHANGELOG.md` updated for the new version.
- [ ] `README.md` reflects current commands / supported tools.
- [ ] `npm run lint && npm run compile` clean on Node 20.
- [ ] Manual smoke test: panel opens, Save/Use/Quick-Switch work for Claude (or Codex).
- [ ] Tag equals `package.json` version (the workflow enforces this).
