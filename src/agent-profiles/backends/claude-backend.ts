import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { log } from '../../log';
import { AccountBackend, AccountIdentity, SnapshotResult } from './account-backend';
import { fileExists, readJsonSafe, restoreDir, snapshotDir } from '../credential-fs';
import {
  isMac,
  readKeychainCredentials,
  readKeychainCredentialsSafe,
  writeKeychainCredentials,
} from './claude-keychain';

const CRED_FILE = '.credentials.json';

const WHITELIST: ReadonlySet<string> = new Set([
  CRED_FILE,
  'settings.json',
  'settings.local.json',
  'claude.json',
  'config.json',
  '.config.json',
]);

// Everything in the whitelist except the credential itself — on macOS the
// credential goes to the Keychain and only these travel as files.
const NON_CRED_WHITELIST: ReadonlySet<string> = new Set(
  Array.from(WHITELIST).filter((n) => n !== CRED_FILE),
);

function claudeHome(): string {
  return path.join(os.homedir(), '.claude');
}

function liveCredFile(): string {
  return path.join(claudeHome(), CRED_FILE);
}

// Claude Code shows the signed-in email / organisation from the `oauthAccount`
// field of ~/.claude.json (in the home dir, NOT inside ~/.claude/). Swapping
// only the token leaves the app displaying the previous account, so that one
// field is saved with the profile and merged back on switch. The rest of
// ~/.claude.json (projects, history, MCP servers) is never touched.
const ACCOUNT_FILE = 'oauth-account.json';

function globalConfigFile(): string {
  return path.join(os.homedir(), '.claude.json');
}

async function snapshotOauthAccount(destDir: string): Promise<boolean> {
  const dest = path.join(destDir, ACCOUNT_FILE);
  const cfg = await readJsonSafe<{ oauthAccount?: unknown }>(globalConfigFile());
  const account = cfg?.oauthAccount;
  if (!account || typeof account !== 'object') {
    // Don't let a previous capture's account linger next to a newer token.
    await fs.promises.rm(dest, { force: true });
    return false;
  }
  await fs.promises.writeFile(dest, JSON.stringify(account, null, 2), { mode: 0o600 });
  return true;
}

async function restoreOauthAccount(snapshotDirPath: string): Promise<boolean> {
  const account = await readJsonSafe<unknown>(path.join(snapshotDirPath, ACCOUNT_FILE));
  if (!account || typeof account !== 'object') return false;
  const file = globalConfigFile();
  let cfg: Record<string, unknown> = {};
  if (await fileExists(file)) {
    // Parse strictly: on a corrupt/unreadable config, bail out rather than
    // overwrite the user's whole ~/.claude.json with just this field.
    const parsed: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('~/.claude.json is not a JSON object');
    }
    cfg = parsed as Record<string, unknown>;
  }
  cfg.oauthAccount = account;
  const tmp = `${file}.agentmgr.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await fs.promises.rename(tmp, file);
  return true;
}

// The token is already swapped when this runs, so a failure here must not fail
// the switch — it only means the app may still display the previous account.
async function restoreOauthAccountSafe(snapshotDirPath: string, written: string[]): Promise<void> {
  try {
    if (await restoreOauthAccount(snapshotDirPath)) written.push(ACCOUNT_FILE);
    else log('Claude: profile has no saved account info; the app may still show the previous email until re-login.');
  } catch (err) {
    log(`Claude: could not update oauthAccount in ~/.claude.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface ClaudeCredentialJson {
  organizationUuid?: string;
  claudeAiOauth?: {
    // Some logins persist the org id inside the oauth blob instead of at the
    // top level; team/SSO accounts may omit it entirely.
    organizationUuid?: string;
    subscriptionType?: string;
    expiresAt?: number;
    accessToken?: string;
    refreshToken?: string;
  };
}

export const claudeBackend: AccountBackend = {
  id: 'claude',
  displayName: 'Claude',
  icon: '🤖',
  fileWhitelist: WHITELIST,
  sentinelFile: '.credentials.json',

  homeDir(): string {
    return claudeHome();
  },

  // ── live-account access ──
  // Windows/Linux: the login is ~/.claude/.credentials.json, a plain file swap.
  // macOS: the same JSON lives in the login Keychain (the file only exists as a
  // fallback), so live reads/writes go through the Keychain. Snapshots always
  // store it as .credentials.json, so readIdentity works for both.
  async isAvailable(): Promise<boolean> {
    if (isMac() && (await readKeychainCredentialsSafe())) return true;
    return fileExists(liveCredFile());
  },

  async readLiveIdentity(): Promise<AccountIdentity | undefined> {
    if (isMac()) {
      const json = await readKeychainCredentialsSafe();
      if (json) {
        try {
          return identityFromJson(JSON.parse(json) as ClaudeCredentialJson);
        } catch { /* fall through to the file */ }
      }
    }
    return claudeBackend.readIdentity(claudeHome());
  },

  async snapshot(destDir: string): Promise<SnapshotResult> {
    const snap = await snapshotDir(claudeHome(), destDir, WHITELIST);
    const json = isMac() ? await readKeychainCredentials() : undefined;
    if (json) {
      // Keychain wins over any stale fallback file copied above.
      await fs.promises.writeFile(path.join(destDir, CRED_FILE), json, { mode: 0o600 });
      if (!snap.files.includes(CRED_FILE)) snap.files.push(CRED_FILE);
    }
    if (await snapshotOauthAccount(destDir)) snap.files.push(ACCOUNT_FILE);
    return snap;
  },

  async restore(snapshotDirPath: string): Promise<string[]> {
    if (!isMac()) {
      const files = await restoreDir(snapshotDirPath, claudeHome(), WHITELIST);
      await restoreOauthAccountSafe(snapshotDirPath, files);
      return files;
    }

    const snapCred = path.join(snapshotDirPath, CRED_FILE);
    let json: string;
    try {
      json = (await fs.promises.readFile(snapCred, 'utf8')).trim();
    } catch {
      throw new Error(
        'This profile has no saved Claude credentials (it was captured before macOS Keychain ' +
        'support). Log in to that account with Claude, then save the profile again.'
      );
    }
    // Credential first: if the Keychain refuses, nothing else has been touched.
    await writeKeychainCredentials(json);
    const written = [CRED_FILE];
    // Keep a pre-existing fallback file in step so it can't resurrect the old account.
    if (await fileExists(liveCredFile())) {
      await restoreDir(snapshotDirPath, claudeHome(), new Set([CRED_FILE]));
    }
    const hasOthers = (await fs.promises.readdir(snapshotDirPath)).some((n) => NON_CRED_WHITELIST.has(n));
    if (hasOthers) {
      written.push(...(await restoreDir(snapshotDirPath, claudeHome(), NON_CRED_WHITELIST)));
    }
    await restoreOauthAccountSafe(snapshotDirPath, written);
    return written;
  },

  async readIdentity(credentialDir: string): Promise<AccountIdentity | undefined> {
    const j = await readJsonSafe<ClaudeCredentialJson>(path.join(credentialDir, CRED_FILE));
    return identityFromJson(j);
  },
};

function identityFromJson(j: ClaudeCredentialJson | undefined): AccountIdentity | undefined {
    const oauth = j?.claudeAiOauth;
    if (!j || !oauth) return undefined;

    const sub = oauth.subscriptionType;
    // organizationUuid usually lives at the top level, but some logins nest it
    // in the oauth blob and team/SSO accounts may omit it entirely — so never
    // treat a missing org as "no account", just as a missing label/signature.
    const org = j.organizationUuid ?? oauth.organizationUuid;
    const exp = oauth.expiresAt;

    // Signature identifies the account so the manager can flag the live one as
    // "active". Prefer the stable org id; when it's absent, fall back to a hash
    // of the refresh token (more stable than the access token, which rotates on
    // every refresh). This keeps org-less team accounts identifiable instead of
    // dropping them. The fallback only drifts if Claude rotates the refresh
    // token between save and detection — acceptable for the minority case.
    let signature: string | undefined;
    if (org) {
      signature = `${org}|${sub ?? ''}`;
    } else {
      const stable = oauth.refreshToken ?? oauth.accessToken;
      if (stable) {
        const h = createHash('sha256').update(stable).digest('hex').slice(0, 16);
        signature = `tok:${h}|${sub ?? ''}`;
      } else if (sub) {
        signature = `sub:${sub}`;
      }
    }
    if (!signature) return undefined;

    const parts: string[] = [];
    if (sub) parts.push(`sub=${sub}`);
    if (org) parts.push(`org=${org.slice(0, 8)}`);
    if (typeof exp === 'number') {
      try { parts.push(`exp=${new Date(exp).toLocaleString()}`); } catch { /* ignore */ }
    }
    return {
      signature,
      text: parts.length ? parts.join(' · ') : '(claude account)',
    };
}
