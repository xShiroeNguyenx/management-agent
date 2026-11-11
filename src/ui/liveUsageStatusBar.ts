import * as vscode from 'vscode';
import { LiveUsage } from '../types';

// Live snapshot (5h/7d/ctx) chi tin cay neu duoc cap nhat gan day. Khi phien Claude
// Code idle, statusLine khong duoc goi -> du lieu cu dan; van hien gia tri cuoi
// nhung danh dau "(cu)" trong tooltip.
const LIVE_STALE_MS = 10 * 60 * 1000;

// Nut status bar hien live usage (5h/7d/context/cost) doc tu status line bridge.
// Chi hien khi tinh nang Live Usage dang bat. Bam de tat.
export class LiveUsageStatusBar {
  private readonly item: vscode.StatusBarItem;
  private live: LiveUsage | null = null;
  private enabled = false;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'agentMgr.toggleLiveUsage';
    // Luon hien (giong nut Auto-Yes) de luon co cho bam BAT/TAT.
    this.item.show();
  }

  start(): void {
    this.render();
    // Re-render dinh ky de nhan "(cu)" + "reset trong" troi theo thoi gian thuc.
    this.timer = setInterval(() => this.render(), 60_000);
  }

  // Cap nhat trang thai tinh nang (item luon hien).
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.live = null;
    this.render();
  }

  // Goi boi LiveUsageWatcher moi khi bridge ghi snapshot moi.
  setLiveUsage(live: LiveUsage): void {
    this.live = live;
    this.render();
  }

  clearLiveUsage(): void {
    this.live = null;
    this.render();
  }

  private render(): void {
    if (!this.enabled) {
      this.item.text = '$(circle-slash) Live: OFF';
      this.item.tooltip = this.buildOffTooltip();
      return;
    }
    const seg = this.liveSegment();
    this.item.text = seg || '$(pulse) Live usage…';
    this.item.tooltip = this.buildTooltip();
  }

  private buildOffTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown(`**Live usage** — đang TẮT\n\n`);
    md.appendMarkdown(
      `Khi bật, gắn \`statusLine\` của Claude Code vào bridge để hiện 5h/7d limit + context%.\n\n`,
    );
    md.appendMarkdown(`_Bấm để BẬT Live Usage._`);
    return md;
  }

  private liveSegment(): string {
    const rl = this.live?.rateLimits;
    if (!rl) return '';
    const seg: string[] = [];
    if (rl.fiveHourPct !== undefined) seg.push(`5h ${Math.round(rl.fiveHourPct)}%`);
    if (rl.sevenDayPct !== undefined) seg.push(`7d ${Math.round(rl.sevenDayPct)}%`);
    return seg.length ? `$(pulse) ${seg.join(' · ')}` : '';
  }

  private buildTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown(`**Live usage** — Claude Code\n\n`);
    if (!this.live) {
      md.appendMarkdown(
        `_Đang chờ status line. Mở (hoặc mở lại) một phiên Claude Code; số liệu xuất hiện sau phản hồi đầu tiên._\n\n`,
      );
      md.appendMarkdown(`_Bấm để TẮT Live Usage._`);
      return md;
    }
    const live = this.live;
    const rl = live.rateLimits;
    const modelSuffix = live.model ? ` · ${live.model}` : '';
    md.appendMarkdown(`Tài khoản${modelSuffix}\n\n`);
    if (rl) {
      md.appendMarkdown(`| Window | Used | Reset |\n|---|---:|---|\n`);
      if (rl.fiveHourPct !== undefined) {
        md.appendMarkdown(`| Session (5h) | ${Math.round(rl.fiveHourPct)}% | ${formatResetIn(rl.fiveHourResetsAt)} |\n`);
      }
      if (rl.sevenDayPct !== undefined) {
        md.appendMarkdown(`| Weekly (7d) | ${Math.round(rl.sevenDayPct)}% | ${formatResetIn(rl.sevenDayResetsAt)} |\n`);
      }
    } else {
      md.appendMarkdown(`_Đang chờ giới hạn (chỉ có với Pro/Max, sau phản hồi đầu tiên)._\n`);
    }
    if (live.contextPct !== undefined) md.appendMarkdown(`\nContext: **${Math.round(live.contextPct)}%**`);
    if (live.costUsd !== undefined) md.appendMarkdown(` · Cost: **$${live.costUsd.toFixed(2)}**`);
    const staleNote = Date.now() - live.updatedAt > LIVE_STALE_MS ? ' ⚠️ (cũ)' : '';
    md.appendMarkdown(`\n\n_Cập nhật ${formatAge(live.updatedAt)}${staleNote}_\n\n_Bấm để TẮT Live Usage._`);
    return md;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.item.dispose();
  }
}

// epoch seconds -> "tự reset trong" dạng ngắn.
function formatResetIn(epochSec?: number): string {
  if (epochSec === undefined) return '—';
  const secs = epochSec - Math.floor(Date.now() / 1000);
  if (secs <= 0) return 'sắp reset';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

function formatAge(updatedAtMs: number): string {
  const m = Math.round((Date.now() - updatedAtMs) / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  return `${Math.round(m / 60)} giờ trước`;
}
