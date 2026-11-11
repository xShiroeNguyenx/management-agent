import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LiveUsage } from '../types';

export interface LiveUsageWatcherOptions {
  // Override file path (mainly for tests). Default: <CLAUDE_CONFIG_DIR|~/.claude>/claude-tracker-live.json
  filePath?: string;
  onUpdate: (usage: LiveUsage) => void;
  log?: (msg: string) => void;
}

export function liveFilePath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'claude-tracker-live.json');
}

// Watches the snapshot file that media/statusline-bridge.cjs writes and emits the
// parsed LiveUsage. Uses fs.watchFile (stat polling) rather than fs.watch: the
// bridge replaces the file via an atomic rename, which makes fs.watch lose the
// inode and stop firing — polling stat survives that. Parse/read failures are
// ignored (last good value stays in the StatusBar).
export class LiveUsageWatcher {
  private readonly file: string;
  private watching = false;

  constructor(private readonly opts: LiveUsageWatcherOptions) {
    this.file = opts.filePath || liveFilePath();
  }

  start(): void {
    // Pick up a snapshot left by a previous session right away.
    void this.read();
    fs.watchFile(this.file, { interval: 2000 }, () => void this.read());
    this.watching = true;
    this.opts.log?.(`[live] watching ${this.file}`);
  }

  private async read(): Promise<void> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch {
      return; // file missing yet — fine
    }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    let obj: any;
    try {
      obj = JSON.parse(raw);
    } catch {
      return; // half-written / corrupt — keep last good
    }
    if (!obj || typeof obj.updatedAt !== 'number') return;
    this.opts.onUpdate(obj as LiveUsage);
  }

  async stop(): Promise<void> {
    if (this.watching) {
      fs.unwatchFile(this.file);
      this.watching = false;
    }
  }
}
