'use strict';

/**
 * Small logging helper with two modes:
 *   - human mode: everything goes to stdout, suitable for `tee` evidence;
 *   - JSON mode (`--json`): human progress goes to stderr so stdout stays a
 *     single parseable JSON document.
 *
 * The scripts intentionally avoid colours and spinners: logs are part of the
 * submitted evidence and must remain readable in a text file.
 */

const state = { json: false };

function setJsonMode(enabled) {
  state.json = Boolean(enabled);
}

function isJson() {
  return state.json;
}

function out(...args) {
  if (state.json) console.error(...args);
  else console.log(...args);
}

function timestamp() {
  return new Date().toISOString();
}

function section(title) {
  out(`\n=== ${title} ===`);
}

function step(label, detail = '') {
  out(`[${timestamp()}] ${label}${detail ? `: ${detail}` : ''}`);
}

function info(message) {
  out(`  ${message}`);
}

function ok(message) {
  out(`  [ok] ${message}`);
}

function warn(message) {
  out(`  [warn] ${message}`);
}

function fail(message) {
  out(`  [fail] ${message}`);
}

function result(okFlag, message) {
  out(`  [${okFlag ? 'ok' : 'fail'}] ${message}`);
}

function table(rows, headers) {
  if (rows.length === 0) return;
  const all = headers ? [headers, ...rows] : rows;
  const widths = [];
  for (const row of all) {
    row.forEach((cell, index) => {
      const text = String(cell ?? '');
      widths[index] = Math.max(widths[index] ?? 0, text.length);
    });
  }
  for (const [index, row] of all.entries()) {
    const line = row
      .map((cell, column) => String(cell ?? '').padEnd(widths[column]))
      .join('  ')
      .trimEnd();
    out(`  ${line}`);
    if (headers && index === 0) {
      out(`  ${widths.map((width) => '-'.repeat(width)).join('  ')}`);
    }
  }
}

function json(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function redactUrl(url) {
  if (!url) return '(not configured)';
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname && parsed.pathname !== '/' ? '/…' : '';
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return '(invalid URL)';
  }
}

function short(value, head = 8, tail = 6) {
  if (value === null || value === undefined) return String(value);
  const text = String(value);
  if (text.length <= head + tail + 2) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function fingerprint(secret) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

function formatTimestamp(unixSeconds) {
  if (unixSeconds === null || unixSeconds === undefined) return '(none)';
  return new Date(Number(unixSeconds) * 1000).toISOString();
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

function formatRelative(targetUnix, nowUnix) {
  const delta = Number(targetUnix) - Number(nowUnix);
  return delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`;
}

module.exports = {
  setJsonMode,
  isJson,
  timestamp,
  section,
  step,
  info,
  ok,
  warn,
  fail,
  result,
  table,
  json,
  redactUrl,
  short,
  fingerprint,
  formatTimestamp,
  formatDuration,
  formatRelative,
};
