import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { log } from '../log';
import { AgentProfileStore } from './profile-store';
import {
  AGENT_PROFILE_DIR,
  AgentProfile,
  DEFAULT_TOOL_ID,
  MAX_BACKUPS,
} from './types';
import {
  fileExists,
  pruneOldBackups,
  removeSnapshotDir,
  restoreDir,
  snapshotDir,
} from './credential-fs';
import { AccountBackend, AccountIdentity, getBackend, listBackends } from './backends/account-backend';
import { GitHubAccountService, GitHubAccountView } from '../github-account-service';

export interface ProfileView {
  id: string;
  name: string;
  tool: string;
  toolDisplayName: string;
  toolIcon: string;
  fileCount: number;
  capturedAt?: number;
  identity?: AccountIdentity;
  active: boolean;
}

// GitHub accounts are auth-based, not file-swappable, so they ride alongside
// the file-swap profiles rather than inside the AccountBackend registry.
export interface GitHubState {
  available: boolean;          // any GitHub account signed in to VS Code?
  usingDefault: boolean;       // no extension-specific preference set?
  accounts: GitHubAccountView[];
}

export class AgentProfileManager {
  private readonly _emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this._emitter.event;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _store: AgentProfileStore,
    private readonly _github?: GitHubAccountService,
  ) {
    // A GitHub swap done from anywhere (command, native menu) should repaint
    // the status bar / Agent Accounts panel too.
    if (this._github) {
      this._disposables.push(this._github.onDidChange(() => this._emitter.fire()));
    }
  }

  dispose(): void {
    while (this._disposables.length) {
      try { this._disposables.pop()?.dispose(); } catch { /* ignore */ }
    }
    this._emitter.dispose();
  }

  // ───────────────────────── github (auth-based) ─────────────────────────
  async getGitHubState(): Promise<GitHubState> {
    if (!this._github) return { available: false, usingDefault: true, accounts: [] };
    const accounts = await this._github.getViews();
    return {
      available: accounts.length > 0,
      usingDefault: this._github.isUsingDefault(),
      accounts,
    };
  }

  async useGitHubAccount(id: string): Promise<void> {
    if (!this._github) throw new Error('GitHub account switching is unavailable.');
    await this._github.useAccountById(id);
  }

  async useGitHubDefault(): Promise<void> {
    if (!this._github) return;
    await this._github.useDefault();
  }

  async addGitHubAccount(): Promise<void> {
    if (!this._github) return;
    const account = await this._github.addAccount();
    if (account) await this._github.useAccount(account);
  }

  list(): AgentProfile[] {
    return this._store.list();
  }

  // ───────────────────────── paths ─────────────────────────
  private _profileRoot(): string {
    return path.join(this._context.globalStorageUri.fsPath, AGENT_PROFILE_DIR);
  }

  private _profileDir(id: string): string {
    return path.join(this._profileRoot(), id);
  }

  private _snapshotDir(id: string): string {
    return path.join(this._profileDir(id), 'snapshot');
  }

  private _backendFor(profile: AgentProfile): AccountBackend | undefined {
    return getBackend(profile.tool);
  }

  // ── backend capability wrappers ──
  // File backends (Claude/Codex) describe a homeDir + whitelist and the manager
  // drives the file copy; custom backends may override these and own the
  // read/write themselves. Everything below treats both uniformly.
  private async _isBackendAvailable(b: AccountBackend): Promise<boolean> {
    if (b.isAvailable) return b.isAvailable();
    if (b.homeDir && b.sentinelFile) return fileExists(path.join(b.homeDir(), b.sentinelFile));
    return false;
  }

  private async _readLiveIdentity(b: AccountBackend): Promise<AccountIdentity | undefined> {
    if (b.readLiveIdentity) return b.readLiveIdentity();
    if (b.homeDir) return b.readIdentity(b.homeDir());
    return undefined;
  }

  private async _snapshotLive(b: AccountBackend, destDir: string): Promise<{ files: string[]; capturedAt: number }> {
    if (b.snapshot) return b.snapshot(destDir);
    if (b.homeDir && b.fileWhitelist) return snapshotDir(b.homeDir(), destDir, b.fileWhitelist);
    return { files: [], capturedAt: Date.now() };
  }

  private async _restoreSnapshot(b: AccountBackend, snapshotDirPath: string): Promise<string[]> {
    if (b.restore) return b.restore(snapshotDirPath);
    if (b.homeDir && b.fileWhitelist) return restoreDir(snapshotDirPath, b.homeDir(), b.fileWhitelist);
    throw new Error(`Backend "${b.id}" cannot restore snapshots.`);
  }

  // Persist live credentials back into the profile that currently owns them
  // BEFORE they get overwritten by a switch. Agent CLIs (Claude/Codex) rotate
  // their OAuth refresh token whenever they refresh the access token, and the
  // old token is invalidated server-side. The snapshot captured at save time
  // therefore goes stale: swapping away and back later restores a dead token
  // and forces a re-login. Re-snapshotting on the way out keeps each profile's
  // saved token current, so round-trip swaps stay logged in.
  //
  // We key off an explicitly tracked per-tool active id (not the credential
  // signature) because org-less Claude accounts derive their signature from the
  // rotating refresh token — signature matching would skip exactly the accounts
  // most exposed to this bug.
  //
  // Limitation: if the user logs into a *different* account for this tool
  // outside the extension, the tracked id still points at the old profile and
  // this would capture the new account's files into it. The availability guard
  // below avoids wiping a profile when nothing is logged in, but cannot detect
  // an out-of-band account change. The extension assumes it owns the swap.
  private async _syncOutActive(b: AccountBackend): Promise<void> {
    const activeId = this._store.getActiveIdForTool(b.id);
    if (!activeId) return;
    const active = this._store.get(activeId);
    if (!active || active.tool !== b.id) return;
    // Nothing logged in → nothing to preserve. Skip so we never clobber a
    // saved snapshot with an empty capture.
    if (!(await this._isBackendAvailable(b))) return;
    try {
      const snapDir = this._snapshotDir(activeId);
      const snap = await this._snapshotLive(b, snapDir);
      if (snap.files.length === 0) return;
      active.claudeSnapshot = {
        dir: path.relative(this._context.globalStorageUri.fsPath, snapDir),
        files: snap.files,
        capturedAt: snap.capturedAt,
      };
      active.updatedAt = Date.now();
      await this._store.upsert(active);
      log(`AgentProfile synced live credentials into "${active.name}" before switch (tool=${b.id})`);
    } catch (err) {
      log(`AgentProfile sync-out warning: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Capture the current live account into a timestamped backup dir, then prune.
  private async _backupCurrent(b: AccountBackend): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(this._profileRoot(), `.backup-${b.id}-${stamp}`);
    try {
      const snap = await this._snapshotLive(b, dir);
      if (snap.files.length === 0) await removeSnapshotDir(dir);
    } catch (err) {
      log(`AgentProfile backup warning: ${err instanceof Error ? err.message : String(err)}`);
    }
    await pruneOldBackups(this._profileRoot(), b.id, MAX_BACKUPS);
  }

  async readSnapshotIdentity(profile: AgentProfile): Promise<AccountIdentity | undefined> {
    const backend = this._backendFor(profile);
    if (!backend) return undefined;
    return backend.readIdentity(this._snapshotDir(profile.id));
  }

  // Each tool has its own live credential, so each tool has its own active
  // profile. Returns a map of toolId → matching profileId. When several
  // profiles of one tool share a signature (duplicate saves), prefer the one
  // the extension last activated; otherwise the first match.
  async detectActiveIds(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const stored = this._store.getActiveId();
    for (const backend of listBackends()) {
      const liveId = await this._readLiveIdentity(backend);
      if (!liveId) continue;
      const matches: string[] = [];
      for (const p of this._store.list()) {
        if (p.tool !== backend.id) continue;
        const snapId = await backend.readIdentity(this._snapshotDir(p.id));
        if (snapId && snapId.signature === liveId.signature) matches.push(p.id);
      }
      if (matches.length === 0) continue;
      // Tie-break duplicates by the profile we last activated for this tool,
      // then the global last-activated, then the first match.
      const trackedForTool = this._store.getActiveIdForTool(backend.id);
      const tieBreak =
        (trackedForTool && matches.includes(trackedForTool) && trackedForTool) ||
        (stored && matches.includes(stored) && stored) ||
        matches[0];
      result.set(backend.id, tieBreak);
    }
    return result;
  }

  async getViews(): Promise<ProfileView[]> {
    const activeIds = await this.detectActiveIds();
    const rows: ProfileView[] = [];
    for (const p of this._store.list()) {
      const backend = this._backendFor(p);
      rows.push({
        id: p.id,
        name: p.name,
        tool: p.tool,
        toolDisplayName: backend?.displayName ?? p.tool,
        toolIcon: backend?.icon ?? '🪪',
        fileCount: p.claudeSnapshot?.files.length ?? 0,
        capturedAt: p.claudeSnapshot?.capturedAt,
        identity: backend ? await backend.readIdentity(this._snapshotDir(p.id)) : undefined,
        active: activeIds.get(p.tool) === p.id,
      });
    }
    return rows;
  }

  // ───────────────────────── save / create ─────────────────────────

  // Returns backends that are logged in / usable right now.
  async detectAvailableBackends(): Promise<AccountBackend[]> {
    const out: AccountBackend[] = [];
    for (const b of listBackends()) {
      if (await this._isBackendAvailable(b)) out.push(b);
    }
    return out;
  }

  async pickBackendForSave(): Promise<AccountBackend | undefined> {
    const available = await this.detectAvailableBackends();
    if (available.length === 1) return available[0];
    if (available.length === 0) {
      // Fall back to any registered backend so the user gets a clear error
      // message about missing credentials, rather than silent nothing.
      const fallback = getBackend(DEFAULT_TOOL_ID) ?? listBackends()[0];
      return fallback;
    }
    const picked = await vscode.window.showQuickPick(
      available.map((b) => ({ label: `${b.icon} ${b.displayName}`, id: b.id })),
      { title: 'Save Agent Profile — pick a tool', placeHolder: 'Multiple tools detected' }
    );
    if (!picked) return undefined;
    return available.find((b) => b.id === picked.id);
  }

  async saveProfile(name: string, opts?: { toolId?: string }): Promise<AgentProfile> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Profile name cannot be empty');
    if (this._store.nameExists(trimmed)) {
      throw new Error(`A profile named "${trimmed}" already exists`);
    }

    const backend = opts?.toolId ? getBackend(opts.toolId) : await this.pickBackendForSave();
    if (!backend) throw new Error('No agent backend available to save');

    const id = randomUUID();
    const snapDir = this._snapshotDir(id);
    const snap = await this._snapshotLive(backend, snapDir);

    if (snap.files.length === 0) {
      await removeSnapshotDir(this._profileDir(id));
      throw new Error(`No ${backend.displayName} credentials found. Log in to ${backend.displayName} first.`);
    }

    const now = Date.now();
    const profile: AgentProfile = {
      id,
      name: trimmed,
      tool: backend.id,
      claudeSnapshot: {
        dir: path.relative(this._context.globalStorageUri.fsPath, snapDir),
        files: snap.files,
        capturedAt: snap.capturedAt,
      },
      createdAt: now,
      updatedAt: now,
    };
    await this._store.upsert(profile);
    if (!this._store.getActiveId()) {
      await this._store.setActive(id);
    }
    // The snapshot we just captured matches the live account for this tool, so
    // this profile now owns the live credentials — track it so the next switch
    // syncs its rotated token back out instead of restoring a stale one.
    await this._store.setActiveIdForTool(backend.id, id);
    log(`AgentProfile saved: ${trimmed} (tool=${backend.id}, ${snap.files.length} files)`);
    this._emitter.fire();
    return profile;
  }

  // ───────────────────────── use / switch ─────────────────────────
  async useProfile(id: string): Promise<AgentProfile> {
    const profile = this._store.get(id);
    if (!profile) throw new Error(`Profile not found: ${id}`);
    const backend = this._backendFor(profile);
    if (!backend) throw new Error(`No backend registered for tool "${profile.tool}"`);

    const snapDir = this._snapshotDir(id);
    // Preserve the outgoing account's (possibly rotated) live token first. When
    // the target is already the active profile this captures live into the same
    // dir we then restore from — a harmless no-op that just refreshes it.
    await this._syncOutActive(backend);
    await this._backupCurrent(backend);
    const written = await this._restoreSnapshot(backend, snapDir);
    await this._store.setActive(id);
    await this._store.setActiveIdForTool(backend.id, id);
    log(`AgentProfile activated: ${profile.name} (tool=${backend.id}, restored ${written.length} files)`);
    this._emitter.fire();
    return profile;
  }

  // ───────────────────────── rename / delete ─────────────────────────
  async renameProfile(id: string, newName: string): Promise<void> {
    const profile = this._store.get(id);
    if (!profile) throw new Error(`Profile not found: ${id}`);
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('Profile name cannot be empty');
    if (this._store.nameExists(trimmed, id)) {
      throw new Error(`A profile named "${trimmed}" already exists`);
    }
    profile.name = trimmed;
    profile.updatedAt = Date.now();
    await this._store.upsert(profile);
    this._emitter.fire();
  }

  async deleteProfile(id: string): Promise<void> {
    const profile = this._store.get(id);
    if (!profile) return;
    try {
      await removeSnapshotDir(this._profileDir(id));
    } catch (err) {
      log(`AgentProfile snapshot cleanup warning: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this._store.remove(id);
    log(`AgentProfile deleted: ${profile.name} (${id})`);
    this._emitter.fire();
  }

  // ───────────────────────── interactive helpers ─────────────────────────
  // One picker for both worlds: file-swap profiles (Claude/Codex) and the
  // auth-based GitHub account the extension uses. This backs the status bar
  // click and the agentMgr.use command.
  async quickPickAndUse(): Promise<AgentProfile | undefined> {
    const views = await this.getViews();
    const github = await this.getGitHubState();

    if (views.length === 0 && !github.available) {
      const choice = await vscode.window.showInformationMessage(
        'No agent profiles saved yet. Save the current session as a profile?',
        'Save current'
      );
      if (choice === 'Save current') {
        await vscode.commands.executeCommand('agentMgr.save');
      }
      return undefined;
    }

    type SwitchItem = vscode.QuickPickItem & {
      act?: 'cli' | 'github' | 'github-default' | 'github-add';
      id?: string;
    };
    const items: SwitchItem[] = [];

    if (views.length) {
      items.push({ label: 'Agent accounts', kind: vscode.QuickPickItemKind.Separator });
      for (const v of views) {
        items.push({
          act: 'cli',
          id: v.id,
          label: `${v.active ? '$(check) ' : `${v.toolIcon} `}${v.name}`,
          description: `${v.toolDisplayName}${v.identity ? ' · ' + v.identity.text : ''}`,
          detail: v.capturedAt
            ? `${v.fileCount} file(s) • captured ${new Date(v.capturedAt).toLocaleString()}`
            : 'No snapshot',
        });
      }
    }

    if (this._github) {
      items.push({ label: 'GitHub (extension / Copilot)', kind: vscode.QuickPickItemKind.Separator });
      items.push({
        act: 'github-default',
        label: `${github.usingDefault ? '$(check) ' : '$(github) '}Use VS Code default account`,
        description: github.usingDefault ? 'Current' : undefined,
      });
      for (const a of github.accounts) {
        items.push({
          act: 'github',
          id: a.id,
          label: `${a.active ? '$(check) ' : '$(github) '}${a.label}`,
          description: a.active ? 'Current' : undefined,
          detail: 'GitHub account this extension uses for Copilot (global)',
        });
      }
      items.push({ act: 'github-add', label: '$(add) Add another GitHub account…' });
    }

    const activeCliIds = new Set(views.filter((v) => v.active).map((v) => v.id));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Accounts — Switch',
      placeHolder: 'Pick an agent profile or a GitHub account',
    });
    if (!picked) return undefined;

    if (picked.act === 'github-default') {
      await this.useGitHubDefault();
      vscode.window.showInformationMessage('Agent Manager will use the VS Code default GitHub account for Copilot.');
      return undefined;
    }
    if (picked.act === 'github-add') {
      await this.addGitHubAccount();
      return undefined;
    }
    if (picked.act === 'github' && picked.id) {
      if (!github.accounts.find((a) => a.id === picked.id)?.active) {
        await this.useGitHubAccount(picked.id);
        const label = github.accounts.find((a) => a.id === picked.id)?.label ?? 'that account';
        vscode.window.showInformationMessage(`Agent Manager will use ${label} for GitHub Copilot.`);
      }
      return undefined;
    }

    // File-swap profile.
    if (!picked.id) return undefined;
    if (activeCliIds.has(picked.id)) return this._store.get(picked.id);
    const profile = await this.useProfile(picked.id);
    const backend = this._backendFor(profile);
    vscode.window.showInformationMessage(
      `Agent profile switched to "${profile.name}" (${backend?.displayName ?? profile.tool}). Restart any running sessions to pick up the new credentials.`
    );
    return profile;
  }

  async warnIfNoLoggedInTool(): Promise<boolean> {
    const available = await this.detectAvailableBackends();
    if (available.length > 0) return true;
    const known = listBackends().map((b) => b.displayName).join(', ');
    const choice = await vscode.window.showWarningMessage(
      `No logged-in tool detected (checked: ${known || 'none registered'}). Save anyway?`,
      { modal: true },
      'Save anyway'
    );
    return choice === 'Save anyway';
  }
}
