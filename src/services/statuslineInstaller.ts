import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const ENABLED_KEY = 'liveUsage.enabled';
const PREV_STATUSLINE_KEY = 'liveUsage.prevStatusLine';
const BRIDGE_MARKER = 'statusline-bridge.cjs';

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function settingsPath(): string {
  return path.join(configDir(), 'settings.json');
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Cau hinh `statusLine` cua Claude Code tro toi bridge cua extension, va go lai.
// Sua settings.json toi thieu: luon backup truoc, idempotent, giu nguyen cac key khac.
export class StatuslineInstaller {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log?: (m: string) => void,
  ) {}

  // Dat bridge o duong dan ON DINH (globalStorage) — KHONG tro vao thu muc cai
  // extension vi path do doi sau moi lan update extension -> statusLine se gay.
  get stablePath(): string {
    return path.join(this.context.globalStorageUri.fsPath, BRIDGE_MARKER);
  }

  private command(): string {
    return `node "${this.stablePath}"`;
  }

  isEnabled(): boolean {
    return this.context.globalState.get<boolean>(ENABLED_KEY) === true;
  }

  // Copy bridge tu VSIX -> stablePath (ghi de). Goi luc enable va luc activate
  // (de ban cap nhat cua extension duoc ap dung).
  async refreshBridge(): Promise<void> {
    const src = this.context.asAbsolutePath(path.join('media', BRIDGE_MARKER));
    await fs.mkdir(path.dirname(this.stablePath), { recursive: true });
    await fs.copyFile(src, this.stablePath);
  }

  private async readSettings(): Promise<{ obj: any; existed: boolean; raw: string }> {
    try {
      let raw = await fs.readFile(settingsPath(), 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      return { obj: JSON.parse(raw), existed: true, raw };
    } catch {
      return { obj: {}, existed: false, raw: '' };
    }
  }

  private async writeSettings(obj: any, existed: boolean, raw: string): Promise<string | null> {
    const p = settingsPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    let bak: string | null = null;
    if (existed) {
      bak = `${p}.bak-${timestamp()}`;
      await fs.writeFile(bak, raw, 'utf8');
    }
    await fs.writeFile(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return bak;
  }

  async enable(): Promise<{ backup: string | null }> {
    await this.refreshBridge();
    const { obj, existed, raw } = await this.readSettings();

    const current = obj.statusLine;
    const currentIsOurs =
      current && typeof current.command === 'string' && current.command.includes(BRIDGE_MARKER);
    // Luu statusLine cu (neu co va khong phai cua ta) de Disable khoi phuc dung.
    if (!currentIsOurs) {
      await this.context.globalState.update(PREV_STATUSLINE_KEY, current ?? null);
    }

    obj.statusLine = { type: 'command', command: this.command() };
    const backup = await this.writeSettings(obj, existed, raw);
    await this.context.globalState.update(ENABLED_KEY, true);
    this.log?.(`[live] enabled; statusLine -> ${this.command()} (backup: ${backup ?? 'none'})`);
    return { backup };
  }

  async disable(): Promise<{ backup: string | null }> {
    const { obj, existed, raw } = await this.readSettings();

    // Chi dung toi statusLine neu hien tai dang la cua ta (tranh ghi de cau hinh
    // nguoi dung tu doi sau do).
    const current = obj.statusLine;
    const currentIsOurs =
      current && typeof current.command === 'string' && current.command.includes(BRIDGE_MARKER);

    let backup: string | null = null;
    if (currentIsOurs) {
      const prev = this.context.globalState.get<any>(PREV_STATUSLINE_KEY, null);
      if (prev) obj.statusLine = prev;
      else delete obj.statusLine;
      backup = await this.writeSettings(obj, existed, raw);
    }
    await this.context.globalState.update(PREV_STATUSLINE_KEY, undefined);
    await this.context.globalState.update(ENABLED_KEY, false);
    this.log?.(`[live] disabled (backup: ${backup ?? 'none'})`);
    return { backup };
  }
}
