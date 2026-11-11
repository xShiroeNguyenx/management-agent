import * as vscode from 'vscode';
import { AutoYesController } from '../services/autoYesController';

// Nut status bar bat/tat auto-yes. Hien thoi gian con lai + nen canh bao khi ON.
export class AutoYesStatusBar {
  private readonly item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly controller: AutoYesController) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.item.command = 'agentMgr.toggleAutoYes';
    this.item.show();
  }

  start(): void {
    this.refresh();
    // Dem nguoc + tu lat ve OFF tren UI khi het han.
    this.timer = setInterval(() => this.refresh(), 60_000);
  }

  refresh(): void {
    const st = this.controller.state();
    if (st.on) {
      const remain = st.remainingMs !== undefined ? ` ${formatRemaining(st.remainingMs)}` : '';
      this.item.text = `$(check) Auto-Yes: ON${remain}`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.text = '$(circle-slash) Auto-Yes: OFF';
      this.item.backgroundColor = undefined;
    }
    this.item.tooltip = this.buildTooltip(st);
  }

  private buildTooltip(st: ReturnType<AutoYesController['state']>): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown(`**Auto-Yes** — ${st.on ? 'ĐANG BẬT ✅' : 'đang TẮT'}\n\n`);
    if (st.on && st.expiresAt !== undefined) {
      md.appendMarkdown(`Tự tắt lúc: ${new Date(st.expiresAt).toLocaleString()}\n\n`);
    }
    md.appendMarkdown(
      `Khi bật, tự đồng ý hầu hết thao tác; **chặn** lệnh huỷ diệt (rm -rf, force-push…); ` +
        `**git commit/push/tag vẫn hỏi**.\n\n`,
    );
    md.appendMarkdown(`_Bấm để ${st.on ? 'TẮT' : 'BẬT'}._`);
    return md;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.item.dispose();
  }
}

function formatRemaining(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
