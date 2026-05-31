import * as vscode from 'vscode';
import { initLogger } from './log';
import { AgentProfileStore } from './agent-profiles/profile-store';
import { AgentProfileManager } from './agent-profiles/profile-manager';
import { AgentProfilePanel } from './agent-profiles/profile-panel';
import { getBackend, registerBackend } from './agent-profiles/backends/account-backend';
import { claudeBackend } from './agent-profiles/backends/claude-backend';
import { codexBackend } from './agent-profiles/backends/codex-backend';
import { GitHubAccountService } from './github-account-service';

registerBackend(claudeBackend);
registerBackend(codexBackend);

class AgentProfileStatusBar {
  private _item: vscode.StatusBarItem;

  constructor(private readonly _manager: AgentProfileManager) {
    this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this._item.command = 'agentMgr.use';
    this.refresh();
    this._item.show();
  }

  refresh(): void {
    void this._refreshAsync();
  }

  private async _refreshAsync(): Promise<void> {
    const activeIds = await this._manager.detectActiveIds();
    const profiles = this._manager.list();
    const actives = Array.from(activeIds.entries())
      .map(([tool, id]) => ({ tool, profile: profiles.find((p) => p.id === id) }))
      .filter((x): x is { tool: string; profile: typeof profiles[number] } => !!x.profile);

    if (actives.length === 0) {
      this._item.text = '$(person) Accounts';
      this._item.tooltip = 'No agent profile matches the live credentials — click to switch';
      return;
    }

    if (actives.length === 1) {
      this._item.text = `$(person) ${actives[0].profile.name}`;
    } else {
      this._item.text = `$(person) ${actives.length} accounts`;
    }
    const lines = actives.map((a) => {
      const label = getBackend(a.tool)?.displayName ?? a.tool;
      return `${label}: ${a.profile.name}`;
    });
    this._item.tooltip = `Active agent accounts:\n${lines.join('\n')}\nClick to switch`;
  }

  dispose(): void {
    this._item.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Agent Manager');
  initLogger(outputChannel);
  context.subscriptions.push(outputChannel);

  // Owns which signed-in GitHub account this extension uses for its own
  // sessions (global). Shared by the Agent Accounts surfaces and the command.
  const githubAccountService = new GitHubAccountService(context);
  context.subscriptions.push(githubAccountService);
  void githubAccountService.ensureAccess();

  const agentProfileStore = new AgentProfileStore(context);
  const agentProfileManager = new AgentProfileManager(context, agentProfileStore, githubAccountService);
  const agentProfileStatusBar = new AgentProfileStatusBar(agentProfileManager);

  context.subscriptions.push(
    agentProfileStatusBar,
    agentProfileManager,
    agentProfileManager.onDidChange(() => agentProfileStatusBar.refresh()),
    vscode.commands.registerCommand('agentMgr.showPanel', () => {
      AgentProfilePanel.reveal(agentProfileManager);
    }),
    vscode.commands.registerCommand('agentMgr.save', async () => {
      const ok = await agentProfileManager.warnIfNoLoggedInTool();
      if (!ok) return;
      const name = await vscode.window.showInputBox({
        prompt: 'Name for this agent profile (e.g. tk1, work, personal)',
        validateInput: (v) => v.trim() ? undefined : 'Name cannot be empty',
      });
      if (!name) return;
      try {
        const p = await agentProfileManager.saveProfile(name);
        vscode.window.showInformationMessage(`Saved agent profile "${p.name}".`);
      } catch (err) {
        vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),
    vscode.commands.registerCommand('agentMgr.list', async () => {
      const views = await agentProfileManager.getViews();
      if (!views.length) {
        vscode.window.showInformationMessage('No agent profiles saved yet.');
        return;
      }
      const items: vscode.QuickPickItem[] = views.map((v) => ({
        label: `${v.active ? '$(check) ' : `${v.toolIcon} `}${v.name}`,
        description: `${v.toolDisplayName}${v.identity ? ' · ' + v.identity.text : ''}`,
        detail: v.capturedAt
          ? `${v.fileCount} file(s) • captured ${new Date(v.capturedAt).toLocaleString()}`
          : 'No snapshot',
      }));
      await vscode.window.showQuickPick(items, {
        title: 'Agent Manager — Agent Accounts',
        placeHolder: 'Press Esc to close',
      });
    }),
    vscode.commands.registerCommand('agentMgr.use', () => {
      return agentProfileManager.quickPickAndUse();
    }),
    vscode.commands.registerCommand('agentMgr.delete', async () => {
      const profiles = agentProfileManager.list();
      if (!profiles.length) {
        vscode.window.showInformationMessage('No agent profiles to delete.');
        return;
      }
      const views = await agentProfileManager.getViews();
      const items = views.map<vscode.QuickPickItem & { id: string }>((v) => ({
        id: v.id,
        label: `${v.toolIcon} ${v.name}`,
        description: `${v.toolDisplayName}${v.identity ? ' · ' + v.identity.text : ''}`,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Delete Agent Profile',
        placeHolder: 'Select a profile to delete',
      });
      if (!picked) return;
      const choice = await vscode.window.showWarningMessage(
        `Delete profile "${picked.label}"? Snapshot will be removed. The tool's live credentials are NOT touched.`,
        { modal: true },
        'Delete'
      );
      if (choice !== 'Delete') return;
      await agentProfileManager.deleteProfile(picked.id);
      vscode.window.showInformationMessage(`Deleted agent profile "${picked.label}".`);
    }),
    // Dedicated GitHub-only picker (global account this extension uses).
    vscode.commands.registerCommand('agentMgr.githubAccount.switch', () => {
      return githubAccountService.pickAccountInteractive();
    }),
  );
}

export function deactivate() {
  // no-op
}
