#!/usr/bin/env node
'use strict';

/**
 * D role command line interface.
 *
 * The CLI is intentionally explicit: every state-changing command names the
 * chain and either a saved swap label or a swap ID.  There is no hidden
 * "auto-recover" behaviour; a failed flow prints the exact refund commands.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const log = require('./lib/log');
const { loadEnv } = require('./lib/env');
const { getConfig, resolveChainName, describeAccount } = require('./lib/config');
const { checkHandoff, describeError } = require('./lib/artifacts');
const {
  assertChain,
  assertContractCode,
  getLatestTimestamp,
  getNativeBalance,
  waitForTimestamp,
  providerFor,
} = require('./lib/chain');
const {
  approveMst,
  lockMst,
  lockEth,
  claimSwap,
  refundSwap,
  readSwap,
  getTokenInfo,
} = require('./lib/protocol');
const { verifyPair, printChecks } = require('./lib/verify');
const { showStatus, showAllStatuses } = require('./lib/status');
const { deployNetwork, deployMstToken, mergeDeployment } = require('./lib/deploy');
const {
  FlowError,
  runSuccess,
  runRefund,
  safeSummary,
} = require('./lib/flows');
const {
  newSecret,
  assertBytes32,
  hashlockOf,
  parseMstAmount,
  parseEthAmount,
  chooseManualTimelock,
} = require('./lib/swap');
const {
  readSwap: readSwapState,
  writeSwap,
  latestSwapLabel,
} = require('./lib/state');

const COMMANDS = [
  'doctor',
  'deploy',
  'deploy-mst',
  'secret',
  'approve',
  'lock',
  'verify',
  'status',
  'claim',
  'refund',
  'success',
  'refund-flow',
  'check-artifacts',
  'help',
];

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const opts = { _: [] };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--') {
      opts._.push(...rest.slice(i + 1));
      break;
    }
    if (arg === '-h') {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      opts._.push(arg);
      continue;
    }

    const equals = arg.indexOf('=');
    let key;
    let value;
    if (equals !== -1) {
      key = arg.slice(2, equals);
      value = arg.slice(equals + 1);
    } else {
      key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }
    key = key.replace(/-([a-zA-Z0-9])/g, (_, character) => character.toUpperCase());
    opts[key] = value;
  }

  return { command, opts };
}

function printHelp() {
  log.section('COMP5521 D role — cross-chain scripts and deployment');
  log.info('Usage: node scripts/cli.js <command> [options]');
  log.info('');
  log.info('Setup and observation:');
  log.info('  doctor                    check RPC, chain IDs, addresses, balances, ABI handoff');
  log.info('  deploy                    deploy ERC20HTLC + ETHHTLC (testnet or --network local)');
  log.info('  deploy-mst                deploy the official Lab 3 MySimpleToken (MST) if the team has none');
  log.info('  secret                    generate a 32-byte preimage and hashlock');
  log.info('  approve                   approve MST for ERC20HTLC');
  log.info('  lock                      create one lock (--chain eth|arb)');
  log.info('  verify                    verify both locks and timelock ordering');
  log.info('  status                    read both chains and derive actionable state');
  log.info('  claim                     claim one side (--chain eth|arb)');
  log.info('  refund                    refund one side after expiry (--chain eth|arb)');
  log.info('  success                   run the complete successful swap');
  log.info('  refund-flow               run the timeout-recovery scenario');
  log.info('  check-artifacts           compare abi/ copies with compiled artifacts');
  log.info('');
  log.info('Common options:');
  log.info('  --network testnet|local   default testnet');
  log.info('  --label <name>            saved scenario in .runtime/swaps/<name>.json');
  log.info('  --json                    machine-readable stdout; progress goes to stderr');
  log.info('  --env-file <path>         load a specific .env file');
  log.info('  --chain eth|arb           chain-side selector');
  log.info('');
  log.info('Examples:');
  log.info('  cp .env.example .env && $EDITOR .env');
  log.info('  node scripts/cli.js doctor');
  log.info('  node scripts/cli.js deploy-mst    # only if the team has no MST address');
  log.info('  node scripts/cli.js deploy');
  log.info('  node scripts/cli.js success --label demo-success');
  log.info('  node scripts/cli.js status --label demo-success');
  log.info('  node scripts/cli.js refund --chain arb --label demo-refund');
  log.info('  npm run local:demo        start two local nodes, deploy and run both flows');
}

function buildOverrides(opts) {
  const network = (opts.network || process.env.HTLC_NETWORK || 'testnet').toLowerCase();
  const local = network === 'local';
  const overrides = {};
  const set = (name, value) => {
    if (value !== undefined && value !== null && value !== true) {
      overrides[name] = String(value);
    }
  };

  set(local ? 'LOCAL_MST_ADDRESS' : 'MST_ADDRESS', opts.mstAddress);
  set(local ? 'LOCAL_ERC20HTLC_ADDRESS' : 'ERC20HTLC_ADDRESS', opts.ethHtlc);
  set(local ? 'LOCAL_ETHHTLC_ADDRESS' : 'ETHHTLC_ADDRESS', opts.arbHtlc);
  set(local ? 'LOCAL_ETH_RPC_URL' : 'SEPOLIA_RPC_URL', opts.rpcEth);
  set(local ? 'LOCAL_ARB_RPC_URL' : 'ARBITRUM_SEPOLIA_RPC_URL', opts.rpcArb);
  set('MST_TIMELOCK_SECONDS', opts.mstSeconds);
  set('ETH_TIMELOCK_SECONDS', opts.ethSeconds);
  set('MIN_TIMELOCK_GAP_SECONDS', opts.minGap);
  set('CONFIRMATIONS', opts.confirmations);
  set('MIN_NATIVE_BALANCE', opts.minNative);
  set('MST_LOCK_AMOUNT', opts.mstAmount);
  set('ETH_LOCK_AMOUNT', opts.ethAmount);
  set('TX_TIMEOUT_MS', opts.txTimeout);

  return overrides;
}

function loadLabeledState(label) {
  const state = readSwapState(label);
  if (!state) {
    throw new Error(
      `No saved scenario "${label}" in .runtime/swaps; run "secret --label ${label}" first`
    );
  }
  return state;
}

function requireState(opts) {
  let label = opts.label;
  if (!label) {
    label = latestSwapLabel();
    if (!label) {
      throw new Error('No saved swap scenario found; pass --label or run secret/lock/success first');
    }
    log.info(`no --label given; using most recent scenario "${label}"`);
  }
  return { label, state: loadLabeledState(label) };
}

function resolveSwapId(opts, state, chainKey) {
  const explicit = opts.swapId;
  const fromState = state?.swaps?.[chainKey]?.swapId;
  const swapId = explicit ?? fromState;
  if (!swapId) {
    throw new Error(
      `No swap ID for ${chainKey}; pass --swap-id or --label for a scenario with a saved ${chainKey} lock`
    );
  }
  return assertBytes32(swapId, 'swapId');
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  writeSwap(state.label, state);
}

function safeConfigSummary(config, envInfo) {
  return {
    network: config.network,
    envFile: envInfo?.file ?? null,
    chains: Object.fromEntries(
      Object.entries(config.chains).map(([key, chain]) => [
        key,
        {
          label: chain.label,
          chainId: chain.chainId,
          rpc: log.redactUrl(chain.rpcUrl),
          htlc: chain.htlcAddress,
          htlcSource: chain.htlcSource,
        },
      ])
    ),
    mstAddress: config.mstAddress,
    accounts: ['deployer', 'alice', 'bob'].map((name) =>
      describeAccount(config.accounts[name])
    ),
    timelocks: config.timelocks,
    confirmations: config.confirmations,
  };
}

async function cmdDoctor(config, opts, envInfo) {
  const errors = [];
  const warnings = [];
  log.section('Configuration');
  log.info(`network mode: ${config.network}`);
  log.info(`env file: ${envInfo?.loaded ? envInfo.file : '(none; using process environment / local defaults)'}`);
  log.info(
    `timelocks: ETH +${config.timelocks.ethSeconds}s, MST +${config.timelocks.mstSeconds}s, gap ${config.timelocks.minGapSeconds}s`
  );
  log.info(`confirmations: ${config.confirmations}`);

  log.section('ABI and bytecode handoff');
  try {
    const checks = checkHandoff();
    for (const check of checks) {
      if (check.ok === null) {
        log.warn(`${check.name}: ${check.detail}`);
        warnings.push(`${check.name}: ${check.detail}`);
      } else {
        log.result(check.ok, `${check.name} — ${check.detail}`);
        if (check.ok === false) errors.push(`${check.name}: ${check.detail}`);
      }
    }
  } catch (error) {
    log.fail(`artifact check failed: ${describeError(error)}`);
    errors.push(`artifact check: ${describeError(error)}`);
  }

  log.section('Accounts');
  const accountRows = [];
  for (const name of ['deployer', 'alice', 'bob']) {
    const account = config.accounts[name];
    accountRows.push([
      name,
      account.address ?? '(not configured)',
      account.privateKey ? 'yes' : 'no',
      account.source ?? '-',
    ]);
    if (!account.address) warnings.push(`${name} address is not configured`);
  }
  log.table(accountRows, ['role', 'address', 'private key', 'source']);

  const nativeRows = [];
  for (const name of ['alice', 'bob']) {
    const account = config.accounts[name];
    if (!account.address) {
      nativeRows.push([name, '(no address)', '(no address)']);
      continue;
    }
    const row = [name];
    for (const chainKey of ['ethereum', 'arbitrum']) {
      try {
        const balance = await getNativeBalance(config, chainKey, account.address);
        row.push(`${ethers.formatEther(balance)}`);
      } catch (error) {
        row.push(`error: ${error.shortMessage ?? error.message}`);
      }
    }
    nativeRows.push(row);
  }
  log.table(nativeRows, [
    'account',
    config.isLocal ? 'Ethereum local ETH' : 'Ethereum Sepolia ETH',
    config.isLocal ? 'Arbitrum local ETH' : 'Arbitrum Sepolia ETH',
  ]);

  for (const chainKey of ['ethereum', 'arbitrum']) {
    const chain = config.chains[chainKey];
    log.section(`${chain.label}`);
    log.info(`RPC: ${log.redactUrl(chain.rpcUrl)}`);
    if (!chain.rpcUrl) {
      log.fail('RPC URL is not configured');
      errors.push(`${chain.label}: RPC URL is not configured`);
      continue;
    }
    try {
      const check = await assertChain(config, chainKey);
      log.ok(`chain ID ${check.chainId}, latest block ${check.blockNumber}`);
    } catch (error) {
      log.fail(error.message);
      errors.push(error.message);
      continue;
    }

    if (chain.htlcAddress) {
      try {
        await assertContractCode(config, chainKey, chain.htlcAddress, chain.kind === 'erc20' ? 'ERC20HTLC' : 'ETHHTLC');
        log.ok(`HTLC code present at ${chain.htlcAddress} (${chain.htlcSource ?? 'configured'})`);
      } catch (error) {
        log.fail(error.message);
        errors.push(error.message);
      }
    } else {
      log.warn('HTLC address is not configured');
      warnings.push(`${chain.label}: HTLC address is not configured`);
    }
  }

  log.section('MST on Ethereum Sepolia');
  if (!config.mstAddress) {
    log.warn('MST address is not configured');
    warnings.push('MST address is not configured');
  } else {
    try {
      const info = await getTokenInfo(config);
      log.ok(`token ${info.address} — ${info.symbol}, ${info.decimals} decimals`);
      const token = new ethers.Contract(
        info.address,
        ['function balanceOf(address) view returns (uint256)'],
        providerFor(config, 'ethereum')
      );
      for (const name of ['alice', 'bob']) {
        const address = config.accounts[name].address;
        if (!address) continue;
        const balance = await token.balanceOf(address);
        log.info(`${name}: ${ethers.formatUnits(balance, info.decimals)} ${info.symbol}`);
      }
    } catch (error) {
      log.fail(describeError(error));
      errors.push(describeError(error));
    }
  }

  log.section('Deployment record');
  if (config.deployment) {
    const source = config.deploymentFile
      ? path.relative(config.root, config.deploymentFile)
      : config.network === 'local'
        ? '.runtime/local/deployments.json'
        : 'deployments/testnet.json';
    log.info(`source: ${source}`);
    if (config.deployment.mstAddress) log.info(`MST: ${config.deployment.mstAddress}`);
    for (const [chainKey, record] of Object.entries(config.deployment.chains ?? {})) {
      log.info(`${config.chains[chainKey]?.label ?? chainKey}: ${record.contract} (${record.name})`);
    }
  } else {
    log.warn('no deployment file yet; run "deploy"');
  }

  const allReady =
    errors.length === 0 &&
    config.chains.ethereum.htlcAddress &&
    config.chains.arbitrum.htlcAddress &&
    config.mstAddress &&
    config.accounts.alice.privateKey &&
    config.accounts.bob.privateKey;

  log.section('Readiness');
  log.result(errors.length === 0, `${errors.length} configuration/connectivity error(s), ${warnings.length} warning(s)`);
  log.result(Boolean(allReady), allReady ? 'READY to run the success and refund flows' : 'NOT READY: complete the warnings above');
  if (errors.length > 0 || (opts.strict && !allReady)) process.exitCode = 1;

  if (opts.json) {
    log.json({
      ok: errors.length === 0,
      ready: Boolean(allReady),
      errors,
      warnings,
      config: safeConfigSummary(config, envInfo),
    });
  }
}

async function cmdDeployMst(config, opts) {
  const record = await deployMstToken(config, {
    force: Boolean(opts.force),
    mintTo: opts.mintTo ?? config.mstMintTo ?? config.accounts.alice.address,
    mintAmount: opts.mintAmount
      ? ethers.parseUnits(String(opts.mintAmount), 18)
      : undefined,
  });

  mergeDeployment(config.network, {
    mstAddress: record.contract,
    mst: record,
    chainIds: { ethereum: config.chains.ethereum.chainId },
  });

  log.section('MST deployment saved');
  log.info(`MST_ADDRESS=${record.contract}`);
  log.info(
    `minted: ${ethers.formatUnits(BigInt(record.mintAmount), 18)} MST to ${record.mintTo}`
  );
  log.info(
    config.network === 'local'
      ? 'saved to .runtime/local/deployments.json'
      : 'saved to deployments/testnet.json'
  );
  if (opts.json) log.json({ ok: true, mst: record });
}

async function cmdDeploy(config, opts) {
  if (!opts.allowStale) {
    const checks = checkHandoff();
    const mismatches = checks.filter((check) => check.ok === false);
    if (mismatches.length > 0) {
      throw new Error(
        `Refusing to deploy stale handoff artifacts: ${mismatches
          .map((check) => `${check.name} (${check.detail})`)
          .join('; ')}. Run "npm run compile" and refresh abi/, or pass --allow-stale.`
      );
    }
  }

  let chains;
  const chainArg = opts.chain ?? 'both';
  if (chainArg === 'both' || chainArg === 'all') {
    chains = ['ethereum', 'arbitrum'];
  } else {
    chains = [resolveChainName(chainArg)];
  }

  const result = await deployNetwork(config, {
    chains,
    withMst: Boolean(opts.withMst),
    mintAmount: opts.mintAmount ? ethers.parseUnits(String(opts.mintAmount), 18) : undefined,
  });

  if (opts.json) {
    log.json({
      ok: true,
      deployment: result.deployment,
      deployed: result.records,
      mst: result.mstRecord,
    });
  }
}

function newManualState(config, label, secret, humanAmounts) {
  return {
    version: 1,
    label,
    scenario: 'manual',
    network: config.network,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'planned',
    parties: {
      alice: config.accounts.alice.address,
      bob: config.accounts.bob.address,
    },
    secret,
    hashlock: hashlockOf(secret),
    amounts: {},
    humanAmounts: {
      mst: humanAmounts.mst,
      eth: humanAmounts.eth,
    },
    timelocks: {},
    swaps: {},
    approvals: {},
    claims: {},
    refunds: {},
    negativeChecks: [],
    checks: [],
    finalChecks: [],
    balances: {},
    error: null,
  };
}

async function cmdSecret(config, opts) {
  const label = opts.label ?? `swap-${stamp()}`;
  if (readSwapState(label)) {
    throw new Error(`Label "${label}" already exists; choose another label or use it directly`);
  }
  const secret = assertBytes32(opts.secret ?? newSecret(), 'secret');
  const state = newManualState(config, label, secret, {
    mst: opts.mstAmount ?? config.amounts.mst,
    eth: opts.ethAmount ?? config.amounts.eth,
  });
  writeSwap(label, state);

  log.section(`Generated swap secret: ${label}`);
  log.info(`hashlock: ${state.hashlock}`);
  log.info(`secret fingerprint: ${log.fingerprint(secret)}`);
  if (opts.showSecret) {
    log.warn('full secret requested on the command line:');
    log.info(secret);
  } else {
    log.info('full secret is stored in the owner-only state file; use --show-secret to print it');
  }
  log.info(`state file: .runtime/swaps/${label}.json`);
  if (opts.json) {
    log.json({
      ok: true,
      label,
      hashlock: state.hashlock,
      secret: opts.showSecret ? secret : undefined,
      secretFingerprint: log.fingerprint(secret),
    });
  }
}

async function cmdApprove(config, opts) {
  const info = await getTokenInfo(config);
  const amount = parseMstAmount(
    opts.amount ?? opts.mstAmount ?? config.amounts.mst,
    info.decimals
  );
  const result = await approveMst(config, { account: opts.account ?? 'alice', amount });
  if (opts.json) log.json({ ok: true, approval: result });
}

async function cmdLock(config, opts) {
  const chainKey = resolveChainName(opts.chain);
  const { label, state } = requireState(opts);
  if (state.swaps[chainKey]) {
    throw new Error(
      `Scenario ${label} already has a ${chainKey} lock (${state.swaps[chainKey].swapId}); use status/claim/refund or a new label`
    );
  }
  if (!state.parties?.alice || !state.parties?.bob) {
    throw new Error(`Scenario ${label} has no participant addresses; start a new scenario`);
  }

  const now = (await getLatestTimestamp(config, chainKey)).timestamp;
  const explicit = opts.timelock;
  const timelock = chooseManualTimelock({
    config,
    chainKey,
    now,
    explicit,
    existingMst: state.swaps.ethereum,
  });

  let record;
  if (chainKey === 'ethereum') {
    const info = await getTokenInfo(config);
    const amount = parseMstAmount(
      opts.mstAmount ?? opts.amount ?? state.humanAmounts?.mst ?? config.amounts.mst,
      info.decimals
    );
    const recipient = opts.recipient ?? state.parties.bob;
    record = await lockMst(config, {
      account: opts.account ?? 'alice',
      recipient,
      amount,
      hashlock: state.hashlock,
      timelock,
      autoApprove: !opts.noApprove,
    });
    state.amounts.mst = record.amount;
    state.humanAmounts.mst = ethers.formatUnits(amount, info.decimals);
    state.timelocks.mst = record.timelock;
  } else {
    const amount = parseEthAmount(
      opts.ethAmount ?? opts.amount ?? state.humanAmounts?.eth ?? config.amounts.eth
    );
    const recipient = opts.recipient ?? state.parties.alice;
    record = await lockEth(config, {
      account: opts.account ?? 'bob',
      recipient,
      amount,
      hashlock: state.hashlock,
      timelock,
    });
    state.amounts.eth = record.amount;
    state.humanAmounts.eth = ethers.formatEther(amount);
    state.timelocks.eth = record.timelock;
  }

  state.swaps[chainKey] = record;
  state.timelocks.minGapSeconds = config.timelocks.minGapSeconds;
  if (record.approval) state.approvals.ethereum = record.approval;
  state.status =
    state.swaps.ethereum && state.swaps.arbitrum
      ? 'both-locked'
      : chainKey === 'ethereum'
        ? 'mst-locked'
        : 'eth-locked';
  saveState(state);

  if (state.swaps.ethereum && state.swaps.arbitrum) {
    const verification = await verifyPair(config, {
      mstId: state.swaps.ethereum.swapId,
      ethId: state.swaps.arbitrum.swapId,
      secret: state.secret,
      expected: {
        mstAmount: state.amounts.mst,
        ethAmount: state.amounts.eth,
        status: 1,
      },
      state,
    });
    printChecks('Cross-chain verification', verification);
    state.checks = verification.checks;
    saveState(state);
    if (!verification.ok) {
      throw new FlowError('Cross-chain verification failed; do not claim', 'Inspect the checks and use refund after expiry if necessary.');
    }
  }

  log.section('Lock saved');
  log.info(`scenario: ${label}`);
  log.info(`swapId: ${record.swapId}`);
  log.info(`tx: ${record.txHash}`);
  log.info(`timelock: ${log.formatTimestamp(record.timelock)}`);
  if (opts.json) log.json({ ok: true, label, lock: record, state: safeSummary(state) });
}

async function cmdVerify(config, opts) {
  const { label, state } = requireState(opts);
  if (!state.swaps?.ethereum || !state.swaps?.arbitrum) {
    throw new Error(`Scenario ${label} needs both locks before verification`);
  }
  const statusMap = { active: 1, claimed: 2, refunded: 3, any: 'any' };
  const requested = (opts.expectStatus ?? 'active').toLowerCase();
  const expectedStatus = statusMap[requested];
  if (expectedStatus === undefined) {
    throw new Error('--expect-status must be active, claimed, refunded or any');
  }

  const result = await verifyPair(config, {
    mstId: state.swaps.ethereum.swapId,
    ethId: state.swaps.arbitrum.swapId,
    secret: opts.secret ?? state.secret,
    expected: {
      mstAmount: state.amounts.mst,
      ethAmount: state.amounts.eth,
      status: expectedStatus,
      minGapSeconds: state.timelocks?.minGapSeconds,
    },
    state,
  });
  printChecks(`Verification: ${label}`, result);
  state.checks = result.checks;
  saveState(state);
  if (opts.json) log.json({ ok: result.ok, label, checks: result.checks });
  if (!result.ok) process.exitCode = 1;
}

async function cmdStatus(config, opts) {
  if (opts.all) {
    const payloads = await showAllStatuses(config, { viewer: opts.viewer });
    if (opts.json) log.json({ ok: true, count: payloads.length, swaps: payloads });
    return;
  }

  let label = opts.label ?? null;
  let state = null;
  if (label) {
    state = loadLabeledState(label);
  } else if (!opts.ethSwapId && !opts.arbSwapId) {
    label = latestSwapLabel();
    if (!label) {
      throw new Error('No saved swap scenario found; pass --label or explicit swap IDs');
    }
    state = loadLabeledState(label);
    log.info(`no --label given; using most recent scenario "${label}"`);
  }

  const payload = await showStatus(config, {
    label,
    state,
    ethSwapId: opts.ethSwapId,
    arbSwapId: opts.arbSwapId,
    viewer: opts.viewer,
  });
  if (opts.json) log.json({ ok: true, ...payload });
}

async function cmdClaim(config, opts) {
  const chainKey = resolveChainName(opts.chain);
  let label = opts.label ?? null;
  let state = null;
  if (label) {
    state = loadLabeledState(label);
  } else if (!opts.swapId) {
    const found = requireState(opts);
    label = found.label;
    state = found.state;
  }

  const swapId = resolveSwapId(opts, state, chainKey);
  const secret = opts.secret ?? state?.secret;
  if (!secret) throw new Error('No secret available; pass --secret or use a saved scenario');
  const account = opts.account ?? (chainKey === 'ethereum' ? 'bob' : 'alice');

  const claim = await claimSwap(config, chainKey, { swapId, secret, account });
  if (state) {
    state.claims[chainKey] = claim;
    state.status =
      state.claims.ethereum && state.claims.arbitrum
        ? 'completed'
        : chainKey === 'arbitrum'
          ? 'eth-claimed'
          : 'mst-claimed';
    saveState(state);
  }

  log.section('Claim saved');
  log.info(`chain: ${config.chains[chainKey].label}`);
  log.info(`swapId: ${swapId}`);
  log.info(`tx: ${claim.txHash}`);
  if (opts.json) log.json({ ok: true, claim, state: state ? safeSummary(state) : null });
}

async function cmdRefund(config, opts) {
  const chainKey = resolveChainName(opts.chain);
  let label = opts.label ?? null;
  let state = null;
  if (label) {
    state = loadLabeledState(label);
  } else if (!opts.swapId) {
    const found = requireState(opts);
    label = found.label;
    state = found.state;
  }

  const swapId = resolveSwapId(opts, state, chainKey);
  if (opts.fastForward) {
    if (!config.isLocal) {
      throw new Error('--fast-forward is only available with --network local');
    }
    const swap = await readSwap(config, chainKey, swapId);
    await waitForTimestamp(config, chainKey, swap.timelock, { fastForward: true });
  }

  const account = opts.account ?? (chainKey === 'ethereum' ? 'alice' : 'bob');
  const refund = await refundSwap(config, chainKey, { swapId, account });
  if (state) {
    state.refunds[chainKey] = refund;
    state.status =
      state.refunds.ethereum && state.refunds.arbitrum
        ? 'completed'
        : chainKey === 'arbitrum'
          ? 'eth-refunded'
          : 'mst-refunded';
    saveState(state);
  }

  log.section('Refund saved');
  log.info(`chain: ${config.chains[chainKey].label}`);
  log.info(`swapId: ${swapId}`);
  log.info(`tx: ${refund.txHash}`);
  if (opts.json) log.json({ ok: true, refund, state: state ? safeSummary(state) : null });
}

function writeEvidence(file, payload) {
  const target = path.resolve(process.cwd(), file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o644 });
  return target;
}

async function cmdSuccess(config, opts) {
  const result = await runSuccess(config, {
    label: opts.label,
    secret: opts.secret,
    mstAmount: opts.mstAmount,
    ethAmount: opts.ethAmount,
    dryRun: Boolean(opts.dryRun),
    autoApprove: !opts.noApprove,
  });

  if (opts.evidence && result.state) {
    const target = writeEvidence(opts.evidence, {
      generatedAt: new Date().toISOString(),
      network: config.network,
      chains: safeConfigSummary(config).chains,
      run: safeSummary(result.state),
    });
    log.info(`evidence written to ${target}`);
  }

  if (opts.json) {
    log.json({ ok: true, dryRun: Boolean(result.dryRun), run: safeSummary(result.state) });
  }
}

async function cmdRefundFlow(config, opts) {
  const result = await runRefund(config, {
    label: opts.label,
    secret: opts.secret,
    mstAmount: opts.mstAmount,
    ethAmount: opts.ethAmount,
    dryRun: Boolean(opts.dryRun),
    autoApprove: !opts.noApprove,
    fastForward: opts.noFastForward || opts.realTime ? false : config.isLocal,
  });

  if (opts.evidence && result.state) {
    const target = writeEvidence(opts.evidence, {
      generatedAt: new Date().toISOString(),
      network: config.network,
      chains: safeConfigSummary(config).chains,
      run: safeSummary(result.state),
    });
    log.info(`evidence written to ${target}`);
  }

  if (opts.json) {
    log.json({ ok: true, dryRun: Boolean(result.dryRun), run: safeSummary(result.state) });
  }
}

async function cmdCheckArtifacts(config, opts) {
  const checks = checkHandoff();
  log.section('abi/ handoff versus compiled artifacts');
  for (const check of checks) {
    if (check.ok === null) log.warn(`${check.name}: ${check.detail}`);
    else log.result(check.ok, `${check.name} — ${check.detail}`);
  }
  const ok = checks.every((check) => check.ok !== false);
  if (opts.json) log.json({ ok, checks });
  if (!ok) process.exitCode = 1;
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  const helpRequested = ['help', '--help', '-h'].includes(command);
  if (opts.help || helpRequested || !COMMANDS.includes(command)) {
    if (!helpRequested && !COMMANDS.includes(command)) {
      log.fail(`Unknown command "${command}"`);
      process.exitCode = 1;
    }
    printHelp();
    return;
  }

  log.setJsonMode(Boolean(opts.json));
  const envInfo = loadEnv(opts.envFile ?? undefined);
  const config = getConfig({
    network: opts.network,
    overrides: buildOverrides(opts),
  });
  config.envInfo = envInfo;

  switch (command) {
    case 'doctor':
      await cmdDoctor(config, opts, envInfo);
      break;
    case 'deploy':
      await cmdDeploy(config, opts);
      break;
    case 'deploy-mst':
      await cmdDeployMst(config, opts);
      break;
    case 'secret':
      await cmdSecret(config, opts);
      break;
    case 'approve':
      await cmdApprove(config, opts);
      break;
    case 'lock':
      await cmdLock(config, opts);
      break;
    case 'verify':
      await cmdVerify(config, opts);
      break;
    case 'status':
      await cmdStatus(config, opts);
      break;
    case 'claim':
      await cmdClaim(config, opts);
      break;
    case 'refund':
      await cmdRefund(config, opts);
      break;
    case 'success':
      await cmdSuccess(config, opts);
      break;
    case 'refund-flow':
      await cmdRefundFlow(config, opts);
      break;
    case 'check-artifacts':
      await cmdCheckArtifacts(config, opts);
      break;
    default:
      printHelp();
  }
}

function handleError(error) {
  if (log.isJson()) {
    log.json({
      ok: false,
      error: error.message,
      hint: error.hint ?? null,
    });
  } else {
    log.fail(error.message);
    if (error.hint) {
      for (const line of String(error.hint).split('\n')) log.info(line);
    }
    if (process.env.DEBUG) console.error(error.stack);
  }
  process.exitCode = 1;
}

main().catch(handleError);
