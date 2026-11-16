'use strict';

/**
 * Minimal .env loader.  The project deliberately avoids adding a runtime
 * dependency just for configuration: the format used here is the small,
 * predictable subset that `.env.example` documents.
 *
 * Real environment variables always win over values in the file, so CI or a
 * shell can override a local `.env` without editing it.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      // Strip an unquoted trailing comment, e.g. `VALUE=abc # note`.
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function loadEnv(explicitPath) {
  const file = explicitPath ? path.resolve(explicitPath) : path.join(ROOT, '.env');
  if (!fs.existsSync(file)) {
    return { loaded: false, file: null, count: 0 };
  }

  const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return { loaded: true, file, count: Object.keys(parsed).length };
}

function env(name, fallback = undefined) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(name, fallback) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return value;
}

function envBool(name, fallback = false) {
  const raw = env(name);
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`Environment variable ${name} must be a boolean, got "${raw}"`);
}

module.exports = { ROOT, loadEnv, parseEnv, env, envInt, envBool };
