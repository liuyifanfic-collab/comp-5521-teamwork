'use strict';

/**
 * Durable local state.
 *
 *   .runtime/swaps/<label>.json    one cross-chain swap scenario, including
 *                                  the preimage before it is revealed. 0600.
 *   .runtime/local/*.json          ephemeral local two-chain deployment/node data.
 *   deployments/testnet.json       public testnet addresses, safe to commit.
 *
 * Nothing here ever contains a private key.  The preimage is the only secret,
 * and it is written with owner-only permissions and ignored by Git.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./env');

const RUNTIME_DIR = path.join(ROOT, '.runtime');
const SWAP_DIR = path.join(RUNTIME_DIR, 'swaps');
const LOCAL_DIR = path.join(RUNTIME_DIR, 'local');

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read JSON file ${file}: ${error.message}`);
  }
}

function writeJson(file, value, options = {}) {
  const mode = options.mode ?? 0o600;
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
  // `mode` is ignored for an existing file, so enforce it explicitly.
  fs.chmodSync(file, mode);
  return file;
}

function sanitizeLabel(label) {
  const text = String(label ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(text)) {
    throw new Error(
      'Label must be 1-80 characters and contain only letters, digits, dot, underscore or dash'
    );
  }
  return text;
}

function swapFile(label) {
  return path.join(SWAP_DIR, `${sanitizeLabel(label)}.json`);
}

function readSwap(label) {
  return readJson(swapFile(label), null);
}

function writeSwap(label, state) {
  return writeJson(swapFile(label), state, { mode: 0o600 });
}

function listSwapLabels() {
  try {
    return fs
      .readdirSync(SWAP_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function latestSwapLabel() {
  const labels = listSwapLabels();
  if (labels.length === 0) return null;
  return labels
    .map((label) => ({ label, mtime: fs.statSync(swapFile(label)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].label;
}

function deploymentFile(network) {
  return network === 'local'
    ? path.join(LOCAL_DIR, 'deployments.json')
    : path.join(ROOT, 'deployments', 'testnet.json');
}

function readDeployment(network) {
  return readJson(deploymentFile(network), null);
}

function writeDeployment(network, deployment) {
  return writeJson(deploymentFile(network), deployment, {
    mode: network === 'local' ? 0o600 : 0o644,
  });
}

function localPath(name) {
  ensureDir(LOCAL_DIR);
  return path.join(LOCAL_DIR, name);
}

module.exports = {
  RUNTIME_DIR,
  SWAP_DIR,
  LOCAL_DIR,
  ensureDir,
  readJson,
  writeJson,
  sanitizeLabel,
  swapFile,
  readSwap,
  writeSwap,
  listSwapLabels,
  latestSwapLabel,
  deploymentFile,
  readDeployment,
  writeDeployment,
  localPath,
};
