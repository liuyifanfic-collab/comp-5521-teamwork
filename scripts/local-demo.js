#!/usr/bin/env node
'use strict';

/**
 * One-command local two-chain rehearsal.
 *
 * Starts two independent Hardhat nodes (chain IDs 31337 and 421614), deploys
 * MockMST + ERC20HTLC + ETHHTLC, then runs the successful swap and the
 * timeout-recovery flow.  This is the reproducible evidence run for D; it does
 * not need a wallet, faucet, RPC key or testnet funds.
 *
 * The public-testnet commands remain the source of truth for the real
 * deployment; this script only removes the network/funding variables.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const log = require('./lib/log');
const { ROOT } = require('./lib/env');
const { getConfig } = require('./lib/config');
const { loadMySimpleToken } = require('./lib/artifacts');
const { deployNetwork } = require('./lib/deploy');
const { runSuccess, runRefund, safeSummary, FlowError } = require('./lib/flows');
const { NODES, startAll, stopAll, waitForRpc, isUp } = require('./local/nodes');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep-nodes') opts.keepNodes = true;
    else if (arg === '--reuse') opts.reuse = true;
    else if (arg === '--real-time') opts.realTime = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--evidence') opts.evidence = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  return opts;
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function baseOverrides() {
  return {
    LOCAL_ETH_RPC_URL: process.env.LOCAL_ETH_RPC_URL || NODES.ethereum.rpcUrl,
    LOCAL_ARB_RPC_URL: process.env.LOCAL_ARB_RPC_URL || NODES.arbitrum.rpcUrl,
    LOCAL_ETH_CHAIN_ID: String(NODES.ethereum.chainId),
    LOCAL_ARB_CHAIN_ID: String(NODES.arbitrum.chainId),
    CONFIRMATIONS: '1',
    MIN_NATIVE_BALANCE: '0',
    TX_TIMEOUT_MS: '120000',
  };
}

function writeEvidence(file, payload) {
  const target = path.resolve(ROOT, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o644 });
  return target;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    log.info('Usage: node scripts/local-demo.js [--reuse] [--keep-nodes] [--real-time] [--json] [--evidence <path>]');
    return;
  }
  log.setJsonMode(Boolean(opts.json));

  // The local demo deploys the official Lab 3 MST token from the compiled
  // artifact; the HTLCs are deployed from A/B's frozen handoff bytecode.
  loadMySimpleToken();

  const evidencePath = opts.evidence ?? 'evidence/d-local-two-chain.json';
  const labels = {
    success: `local-success-${stamp()}`,
    refund: `local-refund-${stamp()}`,
  };
  const run = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    network: 'local',
    labels,
    nodes: {},
    deployment: null,
    success: null,
    refund: null,
  };

  let started = null;
  try {
    log.section('Local two-chain rehearsal');
    log.info(`workspace: ${ROOT}`);
    log.info(`node: ${process.version}`);
    log.info(`evidence: ${evidencePath}`);

    if (!opts.reuse) {
      if (await isUp(NODES.ethereum.rpcUrl) || await isUp(NODES.arbitrum.rpcUrl)) {
        throw new Error(
          'A local RPC is already listening on 8545/8546; run "npm run local:stop" first or use --reuse'
        );
      }
      started = await startAll({ reuse: false });
    } else {
      const [eth, arb] = await Promise.all([
        waitForRpc(NODES.ethereum),
        waitForRpc(NODES.arbitrum),
      ]);
      log.info(`reusing local nodes: chains ${eth.chainId} and ${arb.chainId}`);
    }

    run.nodes = {
      ethereum: { ...NODES.ethereum, started: !opts.reuse },
      arbitrum: { ...NODES.arbitrum, started: !opts.reuse },
    };

    let config = getConfig({ network: 'local', overrides: baseOverrides() });
    log.section('Deploy contracts');
    const deployed = await deployNetwork(config, {
      chains: ['ethereum', 'arbitrum'],
      withMst: true,
      mintAmount: ethers.parseUnits('1000000', 18),
    });
    run.deployment = deployed.deployment;

    // Reload so the freshly written deployment file supplies MST/HTLC addresses.
    config = getConfig({ network: 'local', overrides: baseOverrides() });

    const successConfig = getConfig({
      network: 'local',
      overrides: {
        ...baseOverrides(),
        MST_TIMELOCK_SECONDS: '300',
        ETH_TIMELOCK_SECONDS: '150',
        MIN_TIMELOCK_GAP_SECONDS: '60',
        MST_LOCK_AMOUNT: '100',
        ETH_LOCK_AMOUNT: '0.01',
      },
    });
    log.section('Scenario 1/2: successful atomic swap');
    const success = await runSuccess(successConfig, { label: labels.success });
    run.success = safeSummary(success.state);

    const refundConfig = getConfig({
      network: 'local',
      overrides: {
        ...baseOverrides(),
        MST_TIMELOCK_SECONDS: '60',
        ETH_TIMELOCK_SECONDS: '30',
        MIN_TIMELOCK_GAP_SECONDS: '10',
        MST_LOCK_AMOUNT: '25',
        ETH_LOCK_AMOUNT: '0.005',
      },
    });
    log.section('Scenario 2/2: timeout recovery');
    const refund = await runRefund(refundConfig, {
      label: labels.refund,
      fastForward: !opts.realTime,
    });
    run.refund = safeSummary(refund.state);

    const target = writeEvidence(evidencePath, run);
    log.section('Local rehearsal complete');
    log.ok('success scenario: PASS');
    log.ok('timeout-recovery scenario: PASS');
    log.info(`evidence JSON: ${path.relative(ROOT, target)}`);
    log.info('Nodes are stopped after the run. Rerun with --keep-nodes to inspect them with manual commands.');
    if (opts.json) log.json({ ok: true, evidence: target, run });
  } finally {
    if (started && !opts.keepNodes) {
      await stopAll();
    } else if (started) {
      log.info('nodes left running; stop with: npm run local:stop');
    }
  }
}

main().catch((error) => {
  if (log.isJson()) {
    log.json({ ok: false, error: error.message, hint: error.hint ?? null });
  } else {
    log.fail(error.message);
    if (error instanceof FlowError && error.hint) {
      for (const line of String(error.hint).split('\n')) log.info(line);
    }
    if (process.env.DEBUG) console.error(error.stack);
  }
  process.exitCode = 1;
});
