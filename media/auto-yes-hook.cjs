#!/usr/bin/env node
/*
 * auto-yes-hook.cjs — PreToolUse hook cho Claude Code (do extension Agent Manager cai).
 *
 * Khi file co <CONFIG_DIR>/auto-yes.json dang BAT va con han:
 *   - Lenh trong BLOCK_PATTERNS  -> "deny"  (chan han)
 *   - Lenh trong CONFIRM_PATTERNS-> "ask"   (van hien dialog)
 *   - Con lai                    -> "allow" (tu Yes)
 * Khi co TAT / het han / thieu file / co bat ky loi nao:
 *   - KHONG in gi, exit 0  => Claude Code hoi nhu binh thuong (fail-safe).
 *
 * Nguyen tac: KHONG BAO GIO tu "allow" khi gap loi. Node thuan, khong dependency.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
const FLAG_FILE = path.join(configDir(), 'auto-yes.json');
const LOG_FILE = path.join(configDir(), 'auto-yes.log');

// BLOCK: lenh huy diet / khong the hoan tac -> luon chan han.
const BLOCK_PATTERNS = [
  /\brm\s+-\w*r\w*f/i,
  /\brm\s+-\w*f\w*r/i,
  /\brm\s+-r\b[\s\S]*-f\b/i,
  /\brm\s+-f\b[\s\S]*-r\b/i,
  /-Recurse\b[\s\S]*-Force\b/i,
  /-Force\b[\s\S]*-Recurse\b/i,
  /\b(rmdir|rd)\b[\s\S]*\/s\b/i,
  /\bdel\b[\s\S]*\/(s|q)\b/i,
  /\bformat\s+([a-z]:|\/)/i,
  /\bdiskpart\b/i,
  /\bmkfs\w*/i,
  /\bClear-Disk\b/i,
  /git\s+push\b[\s\S]*(--force|--force-with-lease|\s-f\b)/i,
  /git\s+push\b[\s\S]*--tags\b/i,
  /git\s+reset\s+--hard\b/i,
  /git\s+rebase\b/i,
  /git\s+filter-branch\b/i,
  /git\s+clean\s+-\w*f/i,
  /git\s+update-ref\s+-d\b/i,
  /\b(npm|yarn|pnpm)\s+publish\b/i,
  /\bgh\s+release\b/i,
  /\bshutdown\b/i,
  /\bStop-Computer\b/i,
  /\bRestart-Computer\b/i,
  /\breg\s+delete\b/i,
  /\bSet-ExecutionPolicy\b/i,
  /(curl|wget)\b[\s\S]*\|\s*(sudo\s+)?(ba)?sh\b/i,
  /(iwr|Invoke-WebRequest|curl)\b[\s\S]*\|\s*(iex|Invoke-Expression)/i,
  /\b(iex|Invoke-Expression)\b/i,
];

// CONFIRM: van hien dialog du auto-yes dang bat (ton trong CLAUDE.md).
const CONFIRM_PATTERNS = [/git\s+commit\b/i, /git\s+push\b/i, /git\s+tag\b/i];

const CONFIRM_PATH_PATTERNS = [
  /(^|[\\/])\.env(\.|$)/i,
  /[\\/]\.git[\\/]/i,
  /[\\/]\.claude[\\/]/i,
  /credential/i,
  /id_rsa/i,
  /\.pem$/i,
  /secret/i,
];

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function out(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
}

function logLine(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (_) {
    /* logging khong duoc lam hong hook */
  }
}

function matchAny(patterns, text) {
  for (const re of patterns) if (re.test(text)) return re.source;
  return null;
}

function main() {
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    return;
  }
  let input;
  try {
    input = JSON.parse(stripBom(raw));
  } catch (_) {
    return;
  }

  let flag;
  try {
    flag = JSON.parse(stripBom(fs.readFileSync(FLAG_FILE, 'utf8')));
  } catch (_) {
    return; // chua bat -> defer
  }
  if (!flag || flag.enabled !== true) return;
  if (flag.expiresAt) {
    const exp = Date.parse(flag.expiresAt);
    if (!Number.isNaN(exp) && Date.now() > exp) {
      logLine({ ts: new Date().toISOString(), decision: 'defer', rule: 'expired' });
      return;
    }
  }

  const toolName = input.tool_name || '';
  const ti = input.tool_input || {};
  const command = typeof ti.command === 'string' ? ti.command : '';
  const filePath =
    (typeof ti.file_path === 'string' && ti.file_path) ||
    (typeof ti.notebook_path === 'string' && ti.notebook_path) ||
    '';

  const extraBlock = Array.isArray(flag.extraBlock) ? flag.extraBlock : [];
  const extraConfirm = Array.isArray(flag.extraConfirm) ? flag.extraConfirm : [];
  const toRe = (s) => {
    try {
      return new RegExp(s, 'i');
    } catch (_) {
      return null;
    }
  };
  const blockList = BLOCK_PATTERNS.concat(extraBlock.map(toRe).filter(Boolean));
  const confirmList = CONFIRM_PATTERNS.concat(extraConfirm.map(toRe).filter(Boolean));

  const base = {
    ts: new Date().toISOString(),
    tool: toolName,
    command: command || undefined,
    path: filePath || undefined,
  };

  if (command) {
    const hit = matchAny(blockList, command);
    if (hit) {
      out('deny', `auto-yes: lenh nguy hiem bi chan (rule: ${hit})`);
      logLine({ ...base, decision: 'deny', rule: hit });
      return;
    }
  }
  if (command) {
    const hit = matchAny(confirmList, command);
    if (hit) {
      out('ask', `auto-yes: can xac nhan tay (rule: ${hit})`);
      logLine({ ...base, decision: 'ask', rule: hit });
      return;
    }
  }
  if (filePath) {
    const hit = matchAny(CONFIRM_PATH_PATTERNS, filePath);
    if (hit) {
      out('ask', `auto-yes: duong dan nhay cam (rule: ${hit})`);
      logLine({ ...base, decision: 'ask', rule: hit });
      return;
    }
  }

  const expNote = flag.expiresAt ? ` (het han ${flag.expiresAt})` : '';
  out('allow', `auto-yes ON${expNote}`);
  logLine({ ...base, decision: 'allow', rule: 'default-allow' });
}

try {
  main();
} catch (_) {
  process.exit(0); // moi loi -> defer (an toan)
}
