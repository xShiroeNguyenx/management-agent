#!/usr/bin/env node
/*
 * statusline-bridge.cjs — cau noi status line cua Claude Code cho Agent Manager.
 *
 * Claude Code goi file nay lam `statusLine` command va truyen 1 goi JSON qua stdin
 * (model, rate_limits, context_window, cost...). rate_limits (5h/7d %) CHI co o day
 * — khong co env/file/API nao khac. Bridge:
 *   1) Trich cac so can thiet, ghi ATOMIC ra <CONFIG_DIR>/claude-tracker-live.json
 *      de extension doc.
 *   2) In ra stdout 1 dong status line de nguoi dung van co status line trong CLI.
 *
 * FAIL-SAFE: moi loi -> in chuoi toi thieu + exit 0, KHONG bao gio lam hong status
 * line cua Claude Code. KHONG co dependency ngoai (chay duoc bang node tran).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

// Map goi JSON cua Claude Code -> shape gon cho extension.
function buildLive(input) {
  const live = { updatedAt: Date.now() };

  const model = input && input.model && input.model.display_name;
  if (typeof model === 'string' && model) live.model = model;

  const rl = input && input.rate_limits;
  if (rl) {
    const out = {};
    const fh = rl.five_hour;
    if (fh) {
      if (num(fh.used_percentage) !== undefined) out.fiveHourPct = fh.used_percentage;
      if (num(fh.resets_at) !== undefined) out.fiveHourResetsAt = fh.resets_at;
    }
    const sd = rl.seven_day;
    if (sd) {
      if (num(sd.used_percentage) !== undefined) out.sevenDayPct = sd.used_percentage;
      if (num(sd.resets_at) !== undefined) out.sevenDayResetsAt = sd.resets_at;
    }
    if (Object.keys(out).length) live.rateLimits = out;
  }

  const ctx = input && input.context_window;
  if (ctx && num(ctx.used_percentage) !== undefined) live.contextPct = ctx.used_percentage;

  const cost = input && input.cost;
  if (cost && num(cost.total_cost_usd) !== undefined) live.costUsd = cost.total_cost_usd;

  return live;
}

// Dong status line in ra CLI (toi thieu, de nguoi dung van thay gi do).
function buildStatusLine(live) {
  const parts = [];
  if (live.model) parts.push(live.model);
  const rl = live.rateLimits || {};
  if (rl.fiveHourPct !== undefined) parts.push('5h:' + Math.round(rl.fiveHourPct) + '%');
  if (rl.sevenDayPct !== undefined) parts.push('7d:' + Math.round(rl.sevenDayPct) + '%');
  if (live.contextPct !== undefined) parts.push('ctx:' + Math.round(live.contextPct) + '%');
  return parts.length ? parts.join(' ') : 'Claude';
}

function writeAtomic(file, text) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { raw = ''; }
  if (raw && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM

  let input = null;
  try { input = JSON.parse(raw); } catch (_) { input = null; }

  if (input) {
    const live = buildLive(input);
    try {
      writeAtomic(path.join(configDir(), 'claude-tracker-live.json'), JSON.stringify(live));
    } catch (_) { /* ghi loi cung khong duoc lam hong status line */ }
    process.stdout.write(buildStatusLine(live));
  } else {
    process.stdout.write('Claude');
  }
}

try {
  main();
} catch (_) {
  // Bat ky loi ngoai du kien -> van in chuoi toi thieu, khong crash.
  try { process.stdout.write('Claude'); } catch (_) { /* ignore */ }
}
process.exit(0);
