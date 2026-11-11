import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const HOOK_FILE = 'auto-yes-hook.cjs';
const INSTALLED_KEY = 'autoYes.hookInstalled';

// Lop phong thu thu 2: deny rule trong settings (deny luon thang, ke ca khi hook loi).
const DENY_RULES = [
  'Bash(rm -rf *)',
  'Bash(git push --force *)',
  'Bash(git reset --hard *)',
  'PowerShell(Remove-Item * -Recurse -Force *)',
  'Edit(.git/**)',
  'Edit(.claude/**)',
];

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
function settingsPath(): string {
  return path.join(configDir(), 'settings.json');
}
function flagPath(): string {
  return path.join(configDir(), 'auto-yes.json');
}
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface AutoYesState {
  on: boolean;
  expiresAt?: number; // epoch ms
  remainingMs?: number;
}

// Quan ly auto-yes: bat/tat (file co) + dang ky/go PreToolUse hook trong settings.json.
// Sua settings.json toi thieu: luon backup, idempotent, khong dung toi hook khac.
export class AutoYesController {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log?: (m: string) => void,
  ) {}

  // Hook dat o duong dan ON DINH (globalStorage) — khong tro vao thu muc cai
  // extension vi path doi sau moi update -> hook se gay.
  get stablePath(): string {
    return path.join(this.context.globalStorageUri.fsPath, HOOK_FILE);
  }
  private command(): string {
    return `node "${this.stablePath}"`;
  }

  // Doc dong bo (file nho) de StatusBar render de dang. Da tru het han.
  state(): AutoYesState {
    let flag: any;
    try {
      let raw = fs.readFileSync(flagPath(), 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      flag = JSON.parse(raw);
    } catch {
      return { on: false };
    }
    if (!flag || flag.enabled !== true) return { on: false };
    if (flag.expiresAt) {
      const exp = Date.parse(flag.expiresAt);
      if (!Number.isNaN(exp)) {
        if (Date.now() > exp) return { on: false };
        return { on: true, expiresAt: exp, remainingMs: exp - Date.now() };
      }
    }
    return { on: true };
  }

  isHookInstalled(): boolean {
    return this.context.globalState.get<boolean>(INSTALLED_KEY) === true;
  }

  // Copy hook tu VSIX -> stablePath (ghi de). Goi luc cai va luc activate.
  async refreshHookCopy(): Promise<void> {
    const src = this.context.asAbsolutePath(path.join('media', HOOK_FILE));
    await fsp.mkdir(path.dirname(this.stablePath), { recursive: true });
    await fsp.copyFile(src, this.stablePath);
  }

  private async readSettings(): Promise<{ obj: any; existed: boolean; raw: string }> {
    try {
      let raw = await fsp.readFile(settingsPath(), 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      return { obj: JSON.parse(raw), existed: true, raw };
    } catch {
      return { obj: {}, existed: false, raw: '' };
    }
  }

  private async writeSettings(obj: any, existed: boolean, raw: string): Promise<string | null> {
    const p = settingsPath();
    await fsp.mkdir(path.dirname(p), { recursive: true });
    let bak: string | null = null;
    if (existed) {
      bak = `${p}.bak-${timestamp()}`;
      await fsp.writeFile(bak, raw, 'utf8');
    }
    await fsp.writeFile(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return bak;
  }

  // Dang ky hook + deny rule neu chua co. Idempotent.
  async ensureHookInstalled(): Promise<{ firstInstall: boolean; backup: string | null }> {
    await this.refreshHookCopy();
    const { obj, existed, raw } = await this.readSettings();

    obj.hooks = obj.hooks || {};
    const pre: any[] = Array.isArray(obj.hooks.PreToolUse) ? obj.hooks.PreToolUse : [];
    const present = JSON.stringify(pre).includes(HOOK_FILE);

    if (present) {
      await this.context.globalState.update(INSTALLED_KEY, true);
      return { firstInstall: false, backup: null };
    }

    pre.push({ matcher: '*', hooks: [{ type: 'command', command: this.command(), timeout: 10 }] });
    obj.hooks.PreToolUse = pre;

    obj.permissions = obj.permissions || {};
    const deny: string[] = Array.isArray(obj.permissions.deny) ? obj.permissions.deny : [];
    for (const r of DENY_RULES) if (!deny.includes(r)) deny.push(r);
    obj.permissions.deny = deny;

    const backup = await this.writeSettings(obj, existed, raw);
    await this.context.globalState.update(INSTALLED_KEY, true);
    this.log?.(`[auto-yes] hook installed (backup: ${backup ?? 'none'})`);
    return { firstInstall: true, backup };
  }

  async uninstallHook(): Promise<{ backup: string | null }> {
    await this.disable();
    const { obj, existed, raw } = await this.readSettings();
    let touched = false;

    if (obj.hooks && Array.isArray(obj.hooks.PreToolUse)) {
      const before = obj.hooks.PreToolUse.length;
      obj.hooks.PreToolUse = obj.hooks.PreToolUse.filter(
        (e: any) => !JSON.stringify(e).includes(HOOK_FILE),
      );
      if (obj.hooks.PreToolUse.length !== before) touched = true;
    }
    if (obj.permissions && Array.isArray(obj.permissions.deny)) {
      const before = obj.permissions.deny.length;
      obj.permissions.deny = obj.permissions.deny.filter((r: string) => !DENY_RULES.includes(r));
      if (obj.permissions.deny.length !== before) touched = true;
    }

    let backup: string | null = null;
    if (touched) backup = await this.writeSettings(obj, existed, raw);
    await this.context.globalState.update(INSTALLED_KEY, false);
    this.log?.(`[auto-yes] hook uninstalled (backup: ${backup ?? 'none'})`);
    return { backup };
  }

  async enable(hours: number): Promise<{ firstInstall: boolean; backup: string | null }> {
    const res = await this.ensureHookInstalled();
    const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
    const flag = { enabled: true, expiresAt };
    // Ghi atomic, UTF-8 khong BOM (de hook/Node doc chac chan).
    const tmp = flagPath() + '.tmp';
    await fsp.mkdir(configDir(), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(flag), 'utf8');
    await fsp.rename(tmp, flagPath());
    this.log?.(`[auto-yes] enabled until ${expiresAt}`);
    return res;
  }

  async disable(): Promise<void> {
    await fsp.rm(flagPath(), { force: true });
    this.log?.(`[auto-yes] disabled`);
  }
}
