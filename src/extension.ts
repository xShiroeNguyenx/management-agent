import * as vscode from 'vscode';
import { initLogger, log } from './log';
import { AgentProfileStore } from './agent-profiles/profile-store';
import { AgentProfileManager } from './agent-profiles/profile-manager';
import { AgentProfilePanel } from './agent-profiles/profile-panel';
import { getBackend, registerBackend } from './agent-profiles/backends/account-backend';
import { claudeBackend } from './agent-profiles/backends/claude-backend';
import { codexBackend } from './agent-profiles/backends/codex-backend';
import { GitHubAccountService } from './github-account-service';
import { AutoYesController } from './services/autoYesController';
import { AutoYesStatusBar } from './ui/autoYesStatusBar';
import { StatuslineInstaller } from './services/statuslineInstaller';
import { LiveUsageWatcher } from './services/liveUsageWatcher';
import { LiveUsageStatusBar } from './ui/liveUsageStatusBar';

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

  // globalStorage giu cac ban copy ON DINH cua hook/bridge (path khong doi sau
  // khi update extension). Tao thu muc truoc khi cac controller ghi vao.
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const config = () => vscode.workspace.getConfiguration('agentMgr');

  // ----- Auto-Yes: nut status bar bat/tat. PreToolUse hook duoc dang ky vao
  // settings.json cua Claude Code lan dau bat; cac lan sau chi lat co (file flag).
  const autoYes = new AutoYesController(context, log);
  const autoYesBar = new AutoYesStatusBar(autoYes);
  autoYesBar.start();
  context.subscriptions.push({ dispose: () => autoYesBar.dispose() });
  if (autoYes.isHookInstalled()) {
    void autoYes.refreshHookCopy().catch((e) => log(`[auto-yes] refreshHookCopy failed: ${e}`));
  }

  // ----- Live Usage (5h/7d limits + context%): doc tu snapshot ma statusline
  // bridge ghi ra. Opt-in: chi chay khi nguoi dung bat.
  const liveInstaller = new StatuslineInstaller(context, log);
  const liveBar = new LiveUsageStatusBar();
  liveBar.start();
  context.subscriptions.push({ dispose: () => liveBar.dispose() });
  let liveWatcher: LiveUsageWatcher | null = null;
  const startLiveWatcher = () => {
    if (liveWatcher) return;
    liveWatcher = new LiveUsageWatcher({ onUpdate: (u) => liveBar.setLiveUsage(u), log });
    liveWatcher.start();
  };
  const stopLiveWatcher = async () => {
    await liveWatcher?.stop();
    liveWatcher = null;
  };
  if (liveInstaller.isEnabled()) {
    // Refresh ban bridge on dinh phong khi extension vua duoc update, roi watch.
    void liveInstaller.refreshBridge().catch((e) => log(`[live] refreshBridge failed: ${e}`));
    liveBar.setEnabled(true);
    startLiveWatcher();
  }
  context.subscriptions.push({ dispose: () => void stopLiveWatcher() });

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
    vscode.commands.registerCommand('agentMgr.toggleAutoYes', async () => {
      try {
        if (autoYes.state().on) {
          await autoYes.disable();
          vscode.window.showInformationMessage('Auto-Yes: ĐÃ TẮT.');
        } else {
          const hours = config().get<number>('autoYes.hours') ?? 24;
          const { firstInstall } = await autoYes.enable(hours);
          const note = firstInstall
            ? ' Lần đầu: đã đăng ký hook — mở lại phiên Claude Code để có hiệu lực.'
            : '';
          vscode.window.showInformationMessage(`Auto-Yes: ĐÃ BẬT ${hours}h.${note}`);
        }
        autoYesBar.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Toggle Auto-Yes thất bại: ${e?.message ?? e}`);
      }
    }),
    vscode.commands.registerCommand('agentMgr.uninstallAutoYesHook', async () => {
      try {
        await autoYes.uninstallHook();
        autoYesBar.refresh();
        vscode.window.showInformationMessage('Auto-Yes: đã gỡ hook khỏi settings.json.');
      } catch (e: any) {
        vscode.window.showErrorMessage(`Gỡ Auto-Yes hook thất bại: ${e?.message ?? e}`);
      }
    }),
    vscode.commands.registerCommand('agentMgr.toggleLiveUsage', async () => {
      try {
        if (liveInstaller.isEnabled()) {
          await liveInstaller.disable();
          await stopLiveWatcher();
          liveBar.clearLiveUsage();
          liveBar.setEnabled(false);
          vscode.window.showInformationMessage('Live Usage: ĐÃ TẮT.');
        } else {
          const { backup } = await liveInstaller.enable();
          liveBar.setEnabled(true);
          startLiveWatcher();
          const tail = backup ? ` (backup: ${backup})` : '';
          vscode.window.showInformationMessage(
            `Live Usage: ĐÃ BẬT. Mở lại phiên Claude Code để status line nạp lại.${tail}`,
          );
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`Toggle Live Usage thất bại: ${e?.message ?? e}`);
      }
    }),
  );
}

export function deactivate() {
  // no-op
}
