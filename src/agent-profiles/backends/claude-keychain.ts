import * as os from 'os';
import { spawn } from 'child_process';

// On macOS Claude Code does NOT keep its login in ~/.claude/.credentials.json:
// the same JSON blob lives in the login Keychain as a generic password. Swapping
// files there changes nothing, so the Claude backend reads/writes the Keychain
// item through the system `security` tool instead.
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';

const SECURITY_BIN = '/usr/bin/security';
// `security find-generic-password` exit code when the item does not exist.
const ERR_ITEM_NOT_FOUND = 44;
// `security -i` reads each command with a fixed 4096-byte line buffer; a longer
// line is silently truncated, which would store a corrupt credential.
const MAX_STDIN_LINE = 4000;

export function isMac(): boolean {
  return process.platform === 'darwin';
}

export function keychainAccount(): string {
  return process.env.USER || os.userInfo().username;
}

// ───────────────────────── pure helpers ─────────────────────────

// `security ... -w` prints the secret as text, or as bare hex when it holds
// bytes it considers unprintable. Normalise both to the JSON string.
export function decodeKeychainOutput(stdout: string): string | undefined {
  const raw = stdout.trim();
  if (!raw) return undefined;
  if (raw.startsWith('{')) return raw;
  if (raw.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(raw)) {
    const decoded = Buffer.from(raw, 'hex').toString('utf8').trim();
    if (decoded.startsWith('{')) return decoded;
  }
  return undefined;
}

// Build the one-line command fed to `security -i` on stdin. The secret is
// hex-encoded (-X) so no quoting/escaping of the JSON is ever needed, and it
// travels over stdin so it never shows up in the process list.
export function buildAddCommand(account: string, service: string, secret: string): string {
  for (const [label, v] of [['account', account], ['service', service]] as const) {
    if (!v || /["\\\r\n]/.test(v)) {
      throw new Error(`Unsupported character in Keychain ${label} name.`);
    }
  }
  const hex = Buffer.from(secret, 'utf8').toString('hex');
  const line = `add-generic-password -U -a "${account}" -s "${service}" -X "${hex}"\n`;
  if (Buffer.byteLength(line) > MAX_STDIN_LINE) {
    throw new Error(
      'Claude credentials are too large to write to the macOS Keychain safely ' +
      `(${Buffer.byteLength(line)} bytes, limit ${MAX_STDIN_LINE}). ` +
      'Log in with `claude /login` for this account instead.'
    );
  }
  return line;
}

// ───────────────────────── process plumbing ─────────────────────────

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runSecurity(args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => { /* child exited early; surfaced via close */ });
    child.stdin.end(stdin ?? '');
  });
}

// Returns the credential JSON stored in the Keychain, or undefined when no
// item exists (not logged in). Any other failure (locked keychain, access
// denied) throws so the caller can tell the user why.
export async function readKeychainCredentials(): Promise<string | undefined> {
  const r = await runSecurity([
    'find-generic-password', '-a', keychainAccount(), '-s', KEYCHAIN_SERVICE, '-w',
  ]);
  if (r.code === ERR_ITEM_NOT_FOUND) return undefined;
  if (r.code !== 0) {
    throw new Error(`Cannot read Claude credentials from the macOS Keychain (exit ${r.code}): ${r.stderr.trim()}`);
  }
  return decodeKeychainOutput(r.stdout);
}

// Same as readKeychainCredentials but never throws — for availability checks.
export async function readKeychainCredentialsSafe(): Promise<string | undefined> {
  try {
    return await readKeychainCredentials();
  } catch {
    return undefined;
  }
}

export async function writeKeychainCredentials(json: string): Promise<void> {
  const line = buildAddCommand(keychainAccount(), KEYCHAIN_SERVICE, json);
  const r = await runSecurity(['-i'], line);
  if (r.code !== 0) {
    throw new Error(`Cannot write Claude credentials to the macOS Keychain (exit ${r.code}): ${r.stderr.trim()}`);
  }
  // `security -i` can exit 0 even when the command inside it failed, so read
  // the item back and make sure the swap really happened.
  const now = await readKeychainCredentials();
  if (now !== json.trim()) {
    throw new Error(
      'macOS Keychain did not accept the new Claude credentials' +
      (r.stderr.trim() ? `: ${r.stderr.trim()}` : '.') +
      ' The previous account is still active.'
    );
  }
}
