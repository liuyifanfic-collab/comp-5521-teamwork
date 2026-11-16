'use strict';

/**
 * Start/stop the two local Hardhat JSON-RPC nodes used by the rehearsal.
 *
 *   node scripts/local/nodes.js start
 *   node scripts/local/nodes.js status
 *   node scripts/local/nodes.js stop
 *
 * The nodes use the throw-away Hardhat mnemonic, are bound to 127.0.0.1 and
 * have different chain IDs (31337 and 421614), so the two-chain scripts cannot
 * accidentally treat them as one chain.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, loadEnv } = require('../lib/env');
const { LOCAL_DIR, ensureDir } = require('../lib/state');
const log = require('../lib/log');

loadEnv();

const HARDHAT_BIN = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'hardhat.cmd' : 'hardhat'
);

const NODES = {
  ethereum: {
    key: 'ethereum',
    label: 'Ethereum local',
    port: Number(process.env.LOCAL_ETH_PORT || 8545),
    chainId: Number(process.env.LOCAL_ETH_CHAIN_ID || 31337),
    rpcUrl: process.env.LOCAL_ETH_RPC_URL || 'http://127.0.0.1:8545',
  },
  arbitrum: {
    key: 'arbitrum',
    label: 'Arbitrum local',
    port: Number(process.env.LOCAL_ARB_PORT || 8546),
    chainId: Number(process.env.LOCAL_ARB_CHAIN_ID || 421614),
    rpcUrl: process.env.LOCAL_ARB_RPC_URL || 'http://127.0.0.1:8546',
  },
};

function pidFile(key) {
  return path.join(LOCAL_DIR, `node-${key}.pid`);
}

function logFile(key) {
  return path.join(LOCAL_DIR, `node-${key}.log`);
}

function readPid(key) {
  try {
    return JSON.parse(fs.readFileSync(pidFile(key), 'utf8'));
  } catch {
    return null;
  }
}

async function rpc(url, method, params = [], timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message ?? 'JSON-RPC error');
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

async function isUp(url) {
  try {
    await rpc(url, 'eth_blockNumber');
    return true;
  } catch {
    return false;
  }
}

async function waitForRpc(def, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const chainIdHex = await rpc(def.rpcUrl, 'eth_chainId');
      const chainId = Number(BigInt(chainIdHex));
      if (chainId !== def.chainId) {
        throw new Error(
          `${def.label} RPC reports chain ${chainId}, expected ${def.chainId}; is another node already using port ${def.port}?`
        );
      }
      const blockHex = await rpc(def.rpcUrl, 'eth_blockNumber');
      return { chainId, blockNumber: Number(BigInt(blockHex)) };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(
    `${def.label} did not become ready at ${def.rpcUrl}: ${lastError?.message ?? 'timeout'}`
  );
}

function startNode(def) {
  if (!fs.existsSync(HARDHAT_BIN)) {
    throw new Error('Hardhat is not installed; run "npm ci" before starting the local nodes');
  }
  ensureDir(LOCAL_DIR);
  if (fs.existsSync(logFile(def.key))) {
    fs.appendFileSync(logFile(def.key), `\n=== restart ${new Date().toISOString()} ===\n`);
  }

  const out = fs.openSync(logFile(def.key), 'a');
  const child = spawn(
    HARDHAT_BIN,
    ['node', '--hostname', '127.0.0.1', '--port', String(def.port)],
    {
      cwd: ROOT,
      env: { ...process.env, LOCAL_CHAIN_ID: String(def.chainId) },
      stdio: ['ignore', out, out],
      detached: process.platform !== 'win32',
    }
  );
  fs.closeSync(out);

  fs.writeFileSync(
    pidFile(def.key),
    JSON.stringify(
      {
        pid: child.pid,
        chainId: def.chainId,
        port: def.port,
        rpcUrl: def.rpcUrl,
        startedAt: new Date().toISOString(),
        log: logFile(def.key),
      },
      null,
      2
    )
  );

  child.on('exit', (code, signal) => {
    try {
      fs.appendFileSync(
        logFile(def.key),
        `\n=== exited code=${code} signal=${signal} at ${new Date().toISOString()} ===\n`
      );
    } catch {
      // The process is already gone; nothing useful to do.
    }
    try {
      fs.rmSync(pidFile(def.key), { force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  child.unref();
  log.info(`${def.label} node starting on ${def.rpcUrl} (chain ${def.chainId}, pid ${child.pid})`);
  return child;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopNode(key) {
  const meta = readPid(key);
  if (!meta?.pid) return false;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(meta.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      process.kill(-meta.pid, 'SIGTERM');
    }
    for (let attempt = 0; attempt < 30 && isProcessAlive(meta.pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    fs.rmSync(pidFile(key), { force: true });
    log.info(`stopped ${key} node (pid ${meta.pid})`);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      fs.rmSync(pidFile(key), { force: true });
      return false;
    }
    throw error;
  }
}

async function startAll(options = {}) {
  const started = [];
  try {
    for (const def of Object.values(NODES)) {
      if (options.reuse && (await isUp(def.rpcUrl))) {
        const ready = await waitForRpc(def);
        log.info(`reusing ${def.label} at ${def.rpcUrl} (chain ${ready.chainId})`);
        continue;
      }
      if (await isUp(def.rpcUrl)) {
        throw new Error(
          `${def.label} RPC is already running at ${def.rpcUrl}; stop it first or use --reuse`
        );
      }
      const child = startNode(def);
      started.push(child);
      const ready = await waitForRpc(def);
      log.ok(`${def.label} ready: chain ${ready.chainId}, block ${ready.blockNumber}`);
    }
    return { nodes: NODES, started };
  } catch (error) {
    await stopAll();
    throw error;
  }
}

async function stopAll() {
  for (const key of Object.keys(NODES)) {
    await stopNode(key);
  }
}

async function status() {
  const result = {};
  for (const def of Object.values(NODES)) {
    try {
      const ready = await waitForRpc(def, 3000);
      const meta = readPid(def.key);
      result[def.key] = {
        up: true,
        chainId: ready.chainId,
        blockNumber: ready.blockNumber,
        pid: meta?.pid ?? null,
        rpcUrl: def.rpcUrl,
      };
    } catch {
      result[def.key] = {
        up: false,
        chainId: def.chainId,
        pid: readPid(def.key)?.pid ?? null,
        rpcUrl: def.rpcUrl,
      };
    }
  }
  return result;
}

async function main() {
  const command = process.argv[2] ?? 'status';
  if (command === 'start') {
    await startAll({ reuse: false });
    log.info('Nodes are running in the background. Stop with: npm run local:stop');
  } else if (command === 'stop') {
    await stopAll();
  } else if (command === 'status') {
    const result = await status();
    log.table(
      Object.entries(result).map(([key, value]) => [
        key,
        value.up ? 'up' : 'down',
        value.chainId,
        value.blockNumber ?? '-',
        value.pid ?? '-',
        value.rpcUrl,
      ]),
      ['node', 'state', 'chainId', 'block', 'pid', 'rpc']
    );
  } else {
    throw new Error('Usage: node scripts/local/nodes.js start|stop|status');
  }
}

if (require.main === module) {
  main().catch((error) => {
    log.fail(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  NODES,
  rpc,
  isUp,
  waitForRpc,
  startAll,
  stopAll,
  stopNode,
  status,
};
