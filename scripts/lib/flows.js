'use strict';

/**
 * Cross-chain orchestration: the successful swap and the timeout-recovery
 * scenario.
 *
 * Both flows deliberately repeat the same independent-chain steps:
 *   lock on chain A -> verify -> lock on chain B -> verify both -> act.
 * Nothing here assumes that one HTLC can read the other chain.
 */

const { ethers } = require('ethers');
const log = require('./log');
const {
  assertChain,
  assertContractCode,
  walletFor,
  getLatestTimestamp,
  getNativeBalance,
  waitForTimestamp,
  expectRevert,
} = require('./chain');
const {
  getTokenInfo,
  erc20For,
  htlcFor,
  lockMst,
  lockEth,
  claimSwap,
  refundSwap,
  readSwap,
  snapshotBalances,
} = require('./protocol');
const { verifyPair, printChecks } = require('./verify');
const {
  newSecret,
  assertBytes32,
  hashlockOf,
  planTimelocks,
  parseMstAmount,
  parseEthAmount,
  sameAddress,
  statusName,
} = require('./swap');
const { readSwap: readState, writeSwap } = require('./state');

class FlowError extends Error {
  constructor(message, hint = null) {
    super(message);
    this.name = 'FlowError';
    this.hint = hint;
  }
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    '-',
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('');
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();
  writeSwap(state.label, state);
}

function ensureFlowAccounts(config) {
  for (const name of ['alice', 'bob']) {
    const account = config.accounts[name];
    if (!account?.address) {
      throw new FlowError(
        `Missing address for ${name}; configure ${config.isLocal ? 'the local mnemonic' : `${name.toUpperCase()}_PRIVATE_KEY`} in .env`
      );
    }
    if (!account.privateKey) {
      throw new FlowError(
        `Missing private key for ${name}; this flow must sign transactions for both parties`
      );
    }
  }
  if (sameAddress(config.accounts.alice.address, config.accounts.bob.address)) {
    throw new FlowError('Alice and Bob must be different accounts');
  }
}

function createState(config, scenario, options = {}) {
  const prefix = scenario === 'success' ? 'success' : 'refund';
  const label = options.label ?? `${prefix}-${stamp()}`;
  const existing = readState(label);

  if (existing) {
    if (existing.network !== config.network) {
      throw new FlowError(
        `Label ${label} belongs to network ${existing.network}, not ${config.network}`
      );
    }
    if (existing.scenario && existing.scenario !== scenario) {
      throw new FlowError(
        `Label ${label} belongs to scenario ${existing.scenario}, not ${scenario}`
      );
    }
    if (!['planned', 'failed'].includes(existing.status)) {
      throw new FlowError(
        `Label ${label} already has status ${existing.status}; choose a new label instead of overwriting it`
      );
    }
    if (existing.swaps && (existing.swaps.ethereum || existing.swaps.arbitrum)) {
      throw new FlowError(
        `Label ${label} already contains a lock; use the status/claim/refund commands for recovery or choose a new label`
      );
    }
  }

  const secret = assertBytes32(
    options.secret ?? existing?.secret ?? newSecret(),
    'secret'
  );
  const hashlock = hashlockOf(secret);
  if (options.hashlock && assertBytes32(options.hashlock, 'hashlock') !== hashlock) {
    throw new FlowError('The supplied hashlock does not equal keccak256(secret)');
  }

  return {
    version: 1,
    label,
    scenario,
    network: config.network,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'planned',
    parties: {
      alice: config.accounts.alice.address,
      bob: config.accounts.bob.address,
    },
    secret,
    hashlock,
    amounts: {},
    humanAmounts: {},
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

function tokenDecimals(snapshot) {
  return snapshot?.ethereum?.mst?.decimals ?? 18;
}

function mstAmountOf(snapshot, who) {
  return BigInt(snapshot.ethereum.mst[who]);
}

function nativeAmountOf(snapshot, chainKey, who) {
  return BigInt(snapshot[chainKey].native[who]);
}

async function preflight(config, options) {
  ensureFlowAccounts(config);
  log.section('Preflight');

  await Promise.all([assertChain(config, 'ethereum'), assertChain(config, 'arbitrum')]);
  await Promise.all([
    assertContractCode(config, 'ethereum', config.chains.ethereum.htlcAddress, 'ERC20HTLC'),
    assertContractCode(config, 'arbitrum', config.chains.arbitrum.htlcAddress, 'ETHHTLC'),
  ]);

  const token = await getTokenInfo(config);
  const mstAmount = parseMstAmount(options.mstAmount ?? config.amounts.mst, token.decimals);
  const ethAmount = parseEthAmount(options.ethAmount ?? config.amounts.eth);
  const minNative = ethers.parseEther(String(config.minNativeBalance));

  const [mstBalance, allowance, ethAlice, arbAlice, ethBob, arbBob] = await Promise.all([
    erc20For(config).balanceOf(config.accounts.alice.address),
    erc20For(config).allowance(
      config.accounts.alice.address,
      config.chains.ethereum.htlcAddress
    ),
    getNativeBalance(config, 'ethereum', config.accounts.alice.address),
    getNativeBalance(config, 'arbitrum', config.accounts.alice.address),
    getNativeBalance(config, 'ethereum', config.accounts.bob.address),
    getNativeBalance(config, 'arbitrum', config.accounts.bob.address),
  ]);

  const problems = [];
  if (mstBalance < mstAmount) {
    problems.push(
      `Alice has ${ethers.formatUnits(mstBalance, token.decimals)} MST but needs ${ethers.formatUnits(mstAmount, token.decimals)} MST`
    );
  }
  if (ethAlice < minNative) {
    problems.push(
      `Alice has ${ethers.formatEther(ethAlice)} ETH on Ethereum Sepolia but needs at least ${config.minNativeBalance} ETH for gas`
    );
  }
  if (arbAlice < minNative) {
    problems.push(
      `Alice has ${ethers.formatEther(arbAlice)} ETH on Arbitrum Sepolia but needs at least ${config.minNativeBalance} ETH for gas`
    );
  }
  if (ethBob < minNative) {
    problems.push(
      `Bob has ${ethers.formatEther(ethBob)} ETH on Ethereum Sepolia but needs at least ${config.minNativeBalance} ETH for gas`
    );
  }
  if (arbBob <= ethAmount || arbBob < ethAmount + minNative) {
    problems.push(
      `Bob has ${ethers.formatEther(arbBob)} ETH on Arbitrum Sepolia but needs more than ${ethers.formatEther(ethAmount)} ETH for the lock plus gas`
    );
  }

  log.table(
    [
      [
        'Alice',
        ethers.formatEther(ethAlice),
        ethers.formatEther(arbAlice),
        `${ethers.formatUnits(mstBalance, token.decimals)} ${token.symbol}`,
      ],
      [
        'Bob',
        ethers.formatEther(ethBob),
        ethers.formatEther(arbBob),
        '-',
      ],
    ],
    ['account', 'Ethereum Sepolia ETH', 'Arbitrum Sepolia ETH', 'MST']
  );
  log.info(
    `MST allowance: ${ethers.formatUnits(allowance, token.decimals)} ${token.symbol} (auto-approve will top it up if needed)`
  );
  log.info(
    `lock amounts: ${ethers.formatUnits(mstAmount, token.decimals)} ${token.symbol} / ${ethers.formatEther(ethAmount)} ETH`
  );
  log.info(
    `timelocks: ETH +${config.timelocks.ethSeconds}s < MST +${config.timelocks.mstSeconds}s (safety gap ${config.timelocks.minGapSeconds}s)`
  );

  if (problems.length > 0) {
    throw new FlowError(
      `Preflight failed:\n  - ${problems.join('\n  - ')}`,
      config.isLocal
        ? 'Local accounts are funded by the Hardhat node; check that you are connected to the expected two nodes.'
        : 'Fund the accounts from a Sepolia/Arbitrum Sepolia faucet, then run "doctor" again. Bob needs the ETH lock amount plus gas on Arbitrum.'
    );
  }

  return { token, mstAmount, ethAmount, mstBalance, allowance, minNative };
}

async function plannedTimelocks(config) {
  const [ethTime, arbTime] = await Promise.all([
    getLatestTimestamp(config, 'ethereum'),
    getLatestTimestamp(config, 'arbitrum'),
  ]);
  const plan = planTimelocks(config, Math.max(ethTime.timestamp, arbTime.timestamp));
  return { plan, ethTime, arbTime };
}

function assignAmounts(state, preflightResult) {
  state.amounts = {
    mst: preflightResult.mstAmount.toString(),
    eth: preflightResult.ethAmount.toString(),
  };
  state.humanAmounts = {
    mst: ethers.formatUnits(preflightResult.mstAmount, preflightResult.token.decimals),
    eth: ethers.formatEther(preflightResult.ethAmount),
  };
}

function recoveryHint(config, state) {
  const net = config.isLocal ? ' --network local' : '';
  const lines = [`State file: .runtime/swaps/${state.label}.json`];
  const hasMst = Boolean(state.swaps?.ethereum);
  const hasEth = Boolean(state.swaps?.arbitrum);
  const claimedEth = Boolean(state.claims?.arbitrum);
  const claimedMst = Boolean(state.claims?.ethereum);
  const refundedEth = Boolean(state.refunds?.arbitrum);
  const refundedMst = Boolean(state.refunds?.ethereum);

  if (!hasMst && !hasEth) {
    lines.push('No lock was created; the swap can be discarded or retried with the same label.');
  } else if (hasMst && !hasEth) {
    lines.push(
      `Only the MST lock exists (Active until ${log.formatTimestamp(state.swaps.ethereum.timelock)}).`
    );
    lines.push(
      `Recovery: wait for expiry, then refund as Alice: node scripts/cli.js refund --chain eth --label ${state.label}${net}`
    );
  } else if (!hasMst && hasEth) {
    lines.push(
      `Only the ETH lock exists (Active until ${log.formatTimestamp(state.swaps.arbitrum.timelock)}).`
    );
    lines.push(
      `Recovery: wait for expiry, then refund as Bob: node scripts/cli.js refund --chain arb --label ${state.label}${net}`
    );
  } else {
    lines.push(
      `Both locks exist: ETH until ${log.formatTimestamp(state.swaps.arbitrum.timelock)}, MST until ${log.formatTimestamp(state.swaps.ethereum.timelock)}.`
    );

    if (claimedEth) {
      lines.push('ETH has already been claimed by Alice; do not try to refund it.');
    } else if (refundedEth) {
      lines.push('ETH has already been refunded to Bob.');
    } else {
      lines.push(
        `Recovery: after T_ETH refund ETH as Bob: node scripts/cli.js refund --chain arb --label ${state.label}${net}`
      );
    }

    if (claimedMst) {
      lines.push('MST has already been claimed by Bob.');
    } else if (refundedMst) {
      lines.push('MST has already been refunded to Alice.');
    } else {
      lines.push(
        `Recovery: after T_MST refund MST as Alice: node scripts/cli.js refund --chain eth --label ${state.label}${net}`
      );
    }

    if (claimedEth && !claimedMst) {
      lines.push(
        `URGENT: the secret is public; Bob must claim MST before T_MST: node scripts/cli.js claim --chain eth --label ${state.label}${net}`
      );
    }
    if (claimedMst && !claimedEth) {
      lines.push(
        `URGENT: Bob has revealed the secret by claiming MST; Alice must claim ETH before T_ETH: node scripts/cli.js claim --chain arb --label ${state.label}${net}`
      );
    }
    if (claimedEth && claimedMst) {
      lines.push('Both claims are already recorded; only the final status/reporting step remains.');
    }
    if (refundedEth && refundedMst) {
      lines.push('Both refunds are already recorded; recovery is complete.');
    }
  }

  lines.push(`Inspect: node scripts/cli.js status --label ${state.label}${net}`);
  return lines.join('\n');
}

async function runSuccess(config, options = {}) {
  const state = createState(config, 'success', options);
  log.section(`Cross-chain success flow: ${state.label}`);
  log.info(`hashlock: ${state.hashlock}`);
  log.info(
    `secret fingerprint: ${log.fingerprint(state.secret)} (the full preimage stays in the 0600 state file until the claim reveals it)`
  );

  try {
    const pre = await preflight(config, options);
    assignAmounts(state, pre);
    state.balances.initial = await snapshotBalances(config);
    saveState(state);

    const { plan } = await plannedTimelocks(config);
    state.timelocks = { ...plan, minGapSeconds: config.timelocks.minGapSeconds };
    saveState(state);
    log.info(
      `planned timelocks: ETH ${log.formatTimestamp(plan.eth)} (T2), MST ${log.formatTimestamp(plan.mst)} (T1), gap ${log.formatDuration(plan.gapSeconds)}`
    );

    if (options.dryRun) {
      log.section('Dry run');
      log.ok('preflight and timelock plan are valid; no transaction was sent');
      state.status = 'planned';
      saveState(state);
      return { ok: true, dryRun: true, state };
    }

    const mstWallet = walletFor(config, 'ethereum', 'alice');
    log.section('Step 1: lock MST on Ethereum Sepolia');
    log.info(`Alice ${mstWallet.address} locks MST for Bob ${config.accounts.bob.address}`);
    state.swaps.ethereum = await lockMst(config, {
      account: 'alice',
      recipient: config.accounts.bob.address,
      amount: pre.mstAmount,
      hashlock: state.hashlock,
      timelock: plan.mst,
      autoApprove: options.autoApprove !== false,
    });
    if (state.swaps.ethereum.approval) state.approvals.ethereum = state.swaps.ethereum.approval;
    state.status = 'mst-locked';
    saveState(state);

    log.section('Step 2: lock ETH on Arbitrum Sepolia');
    log.info(
      `Bob ${config.accounts.bob.address} locks ETH for Alice ${config.accounts.alice.address} with T_ETH < T_MST`
    );
    state.swaps.arbitrum = await lockEth(config, {
      account: 'bob',
      recipient: config.accounts.alice.address,
      amount: pre.ethAmount,
      hashlock: state.hashlock,
      timelock: plan.eth,
    });
    state.status = 'both-locked';
    saveState(state);

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
    state.balances.locked = await snapshotBalances(config);
    saveState(state);
    if (!verification.ok) {
      throw new FlowError(
        'Cross-chain verification failed; refusing to claim',
        recoveryHint(config, state)
      );
    }

    log.section('Step 3: Alice claims ETH on Arbitrum Sepolia');
    state.claims.arbitrum = await claimSwap(config, 'arbitrum', {
      swapId: state.swaps.arbitrum.swapId,
      secret: state.secret,
      account: 'alice',
    });
    state.status = 'eth-claimed';
    saveState(state);

    log.section('Step 4: Bob claims MST on Ethereum Sepolia');
    state.claims.ethereum = await claimSwap(config, 'ethereum', {
      swapId: state.swaps.ethereum.swapId,
      secret: state.secret,
      account: 'bob',
    });
    state.status = 'completed';
    saveState(state);

    const final = await finalizeSuccess(config, state);
    state.finalChecks = final.checks;
    state.balances.final = final.balances;
    saveState(state);

    printSummary(config, state);
    return { ok: true, state, verification, final };
  } catch (error) {
    state.status = 'failed';
    state.error = {
      message: error.message,
      hint: error.hint ?? null,
      at: new Date().toISOString(),
    };
    saveState(state);
    if (error instanceof FlowError) throw error;
    throw new FlowError(error.message, recoveryHint(config, state));
  }
}

async function finalizeSuccess(config, state) {
  log.section('Final state');
  const [mst, eth, balances] = await Promise.all([
    readSwap(config, 'ethereum', state.swaps.ethereum.swapId),
    readSwap(config, 'arbitrum', state.swaps.arbitrum.swapId),
    snapshotBalances(config),
  ]);

  const checks = [];
  checks.push({
    id: 'F01',
    ok: mst.status === 2 && eth.status === 2,
    label: 'both swaps are Claimed (2)',
    detail: `MST ${statusName(mst.status)}, ETH ${statusName(eth.status)}`,
  });

  const mstAmount = BigInt(state.amounts.mst);
  const ethAmount = BigInt(state.amounts.eth);
  const initial = state.balances.initial;
  const locked = state.balances.locked ?? initial;
  const mstAliceDelta = mstAmountOf(balances, 'alice') - mstAmountOf(initial, 'alice');
  const mstBobDelta = mstAmountOf(balances, 'bob') - mstAmountOf(initial, 'bob');
  const mstHtlcDelta = mstAmountOf(balances, 'htlc') - mstAmountOf(locked, 'htlc');
  checks.push({
    id: 'F02',
    ok: mstAliceDelta === -mstAmount && mstBobDelta === mstAmount,
    label: 'MST moved from Alice to Bob exactly once',
    detail: `Alice ${mstAliceDelta}, Bob +${mstBobDelta}`,
  });
  checks.push({
    id: 'F03',
    ok: mstHtlcDelta === -mstAmount,
    label: 'ERC20HTLC released exactly the locked MST amount',
    detail: `vault delta ${mstHtlcDelta}`,
  });

  const ethHtlcDelta =
    nativeAmountOf(balances, 'arbitrum', 'htlc') -
    nativeAmountOf(locked, 'arbitrum', 'htlc');
  checks.push({
    id: 'F04',
    ok: ethHtlcDelta === -ethAmount,
    label: 'ETHHTLC released exactly the locked ETH amount',
    detail: `vault delta ${ethHtlcDelta}`,
  });

  if (state.claims.arbitrum && state.claims.ethereum) {
    checks.push({
      id: 'F05',
      ok:
        hashlockOf(state.claims.arbitrum.secret) === state.hashlock &&
        hashlockOf(state.claims.ethereum.secret) === state.hashlock,
      label: 'both Claimed events reveal the same preimage matching the hashlock',
      detail: `secret fingerprint ${log.fingerprint(state.secret)}`,
    });
  }

  checks.forEach((check) => log.result(check.ok, `${check.id} ${check.label} — ${check.detail}`));
  printBalanceTable({ ...state, balances: { ...state.balances, final: balances } });
  state.finalChecks = checks;
  state.balances.final = balances;
  const ok = checks.every((check) => check.ok);
  log.result(ok, `success flow final checks: ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) throw new FlowError('Final success checks failed', recoveryHint(config, state));
  return { checks, balances };
}

async function negativeChecks(config, state) {
  log.section('Negative checks before expiry (read-only eth_call)');
  const mstId = state.swaps.ethereum.swapId;
  const ethId = state.swaps.arbitrum.swapId;
  const aliceEth = walletFor(config, 'ethereum', 'alice');
  const bobEth = walletFor(config, 'ethereum', 'bob');
  const aliceArb = walletFor(config, 'arbitrum', 'alice');
  const bobArb = walletFor(config, 'arbitrum', 'bob');
  const mstHtlc = htlcFor(config, 'ethereum', aliceEth);
  const ethHtlc = htlcFor(config, 'arbitrum', aliceArb);
  const wrongSecret = ethers.hexlify(ethers.randomBytes(32));
  if (hashlockOf(wrongSecret) === state.hashlock) {
    throw new FlowError('Random wrong secret unexpectedly matches the hashlock');
  }

  const checks = [
    await expectRevert(
      'ETH refund before expiry (Bob)',
      () => ethHtlc.connect(bobArb).refund.staticCall(ethId),
      'SwapNotExpired'
    ),
    await expectRevert(
      'ETH claim with a wrong secret (Alice)',
      () => ethHtlc.connect(aliceArb).claim.staticCall(ethId, wrongSecret),
      'InvalidSecret'
    ),
    await expectRevert(
      'ETH claim by the sender, not the recipient (Bob)',
      () => ethHtlc.connect(bobArb).claim.staticCall(ethId, state.secret),
      'UnauthorizedReceiver'
    ),
    await expectRevert(
      'MST refund by the recipient, not the sender (Bob)',
      () => mstHtlc.connect(bobEth).refund.staticCall(mstId),
      'UnauthorizedSender'
    ),
    await expectRevert(
      'MST claim by the sender, not the recipient (Alice)',
      () => mstHtlc.connect(aliceEth).claim.staticCall(mstId, state.secret),
      'UnauthorizedReceiver'
    ),
  ];

  const [mst, eth] = await Promise.all([
    readSwap(config, 'ethereum', mstId),
    readSwap(config, 'arbitrum', ethId),
  ]);
  checks.push({
    id: 'N06',
    ok: mst.status === 1 && eth.status === 1,
    label: 'negative calls left both swaps Active',
    detail: `MST ${statusName(mst.status)}, ETH ${statusName(eth.status)}`,
  });

  state.negativeChecks = checks;
  const ok = checks.every((check) => check.ok !== false);
  log.result(ok, `negative checks: ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) throw new FlowError('A negative check did not revert as expected', recoveryHint(config, state));
  return checks;
}

async function runRefund(config, options = {}) {
  const state = createState(config, 'refund', options);
  log.section(`Cross-chain timeout-recovery flow: ${state.label}`);
  log.info(`hashlock: ${state.hashlock}`);
  log.info(`secret fingerprint: ${log.fingerprint(state.secret)}`);

  try {
    const pre = await preflight(config, options);
    assignAmounts(state, pre);
    state.balances.initial = await snapshotBalances(config);
    saveState(state);

    const { plan } = await plannedTimelocks(config);
    state.timelocks = { ...plan, minGapSeconds: config.timelocks.minGapSeconds };
    saveState(state);
    log.info(
      `planned timelocks: ETH ${log.formatTimestamp(plan.eth)} (T2), MST ${log.formatTimestamp(plan.mst)} (T1), gap ${log.formatDuration(plan.gapSeconds)}`
    );

    if (options.dryRun) {
      log.section('Dry run');
      log.ok('preflight and timelock plan are valid; no transaction was sent');
      state.status = 'planned';
      saveState(state);
      return { ok: true, dryRun: true, state };
    }

    log.section('Step 1: lock MST on Ethereum Sepolia');
    state.swaps.ethereum = await lockMst(config, {
      account: 'alice',
      recipient: config.accounts.bob.address,
      amount: pre.mstAmount,
      hashlock: state.hashlock,
      timelock: plan.mst,
      autoApprove: options.autoApprove !== false,
    });
    if (state.swaps.ethereum.approval) state.approvals.ethereum = state.swaps.ethereum.approval;
    state.status = 'mst-locked';
    saveState(state);

    log.section('Step 2: lock ETH on Arbitrum Sepolia');
    state.swaps.arbitrum = await lockEth(config, {
      account: 'bob',
      recipient: config.accounts.alice.address,
      amount: pre.ethAmount,
      hashlock: state.hashlock,
      timelock: plan.eth,
    });
    state.status = 'both-locked';
    saveState(state);

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
    state.balances.locked = await snapshotBalances(config);
    saveState(state);
    if (!verification.ok) {
      throw new FlowError('Cross-chain verification failed', recoveryHint(config, state));
    }

    await negativeChecks(config, state);
    saveState(state);

    log.section('Step 3: wait for T_ETH, then refund ETH');
    await waitForTimestamp(config, 'arbitrum', plan.eth, {
      fastForward: options.fastForward ?? config.isLocal,
    });
    const aliceArb = walletFor(config, 'arbitrum', 'alice');
    const ethHtlc = htlcFor(config, 'arbitrum', aliceArb);
    const expiredEthClaim = await expectRevert(
      'ETH claim after expiry (Alice)',
      () => ethHtlc.connect(aliceArb).claim.staticCall(state.swaps.arbitrum.swapId, state.secret),
      'SwapExpired'
    );
    state.negativeChecks.push({
      id: 'N07',
      ...expiredEthClaim,
      label: 'ETH claim after expiry is rejected',
    });

    state.refunds.arbitrum = await refundSwap(config, 'arbitrum', {
      swapId: state.swaps.arbitrum.swapId,
      account: 'bob',
    });
    state.status = 'eth-refunded';
    saveState(state);

    log.section('Step 4: wait for T_MST, then refund MST');
    await waitForTimestamp(config, 'ethereum', plan.mst, {
      fastForward: options.fastForward ?? config.isLocal,
    });
    const bobEth = walletFor(config, 'ethereum', 'bob');
    const mstHtlc = htlcFor(config, 'ethereum', bobEth);
    const expiredMstClaim = await expectRevert(
      'MST claim after expiry (Bob)',
      () => mstHtlc.connect(bobEth).claim.staticCall(state.swaps.ethereum.swapId, state.secret),
      'SwapExpired'
    );
    state.negativeChecks.push({
      id: 'N08',
      ...expiredMstClaim,
      label: 'MST claim after expiry is rejected',
    });

    state.refunds.ethereum = await refundSwap(config, 'ethereum', {
      swapId: state.swaps.ethereum.swapId,
      account: 'alice',
    });
    state.status = 'completed';
    saveState(state);

    const final = await finalizeRefund(config, state);
    state.finalChecks = final.checks;
    state.balances.final = final.balances;
    saveState(state);

    printSummary(config, state);
    return { ok: true, state, verification, final };
  } catch (error) {
    state.status = 'failed';
    state.error = {
      message: error.message,
      hint: error.hint ?? null,
      at: new Date().toISOString(),
    };
    saveState(state);
    if (error instanceof FlowError) throw error;
    throw new FlowError(error.message, recoveryHint(config, state));
  }
}

async function finalizeRefund(config, state) {
  log.section('Final state');
  const [mst, eth, balances] = await Promise.all([
    readSwap(config, 'ethereum', state.swaps.ethereum.swapId),
    readSwap(config, 'arbitrum', state.swaps.arbitrum.swapId),
    snapshotBalances(config),
  ]);

  const checks = [];
  checks.push({
    id: 'R01',
    ok: mst.status === 3 && eth.status === 3,
    label: 'both swaps are Refunded (3)',
    detail: `MST ${statusName(mst.status)}, ETH ${statusName(eth.status)}`,
  });

  const mstAmount = BigInt(state.amounts.mst);
  const ethAmount = BigInt(state.amounts.eth);
  const initial = state.balances.initial;
  const locked = state.balances.locked ?? initial;
  const mstAliceDelta = mstAmountOf(balances, 'alice') - mstAmountOf(locked, 'alice');
  const mstHtlcDelta = mstAmountOf(balances, 'htlc') - mstAmountOf(locked, 'htlc');
  checks.push({
    id: 'R02',
    ok: mstAliceDelta === mstAmount,
    label: 'Alice recovered the full MST amount after the lock',
    detail: `Alice delta ${mstAliceDelta}`,
  });
  checks.push({
    id: 'R03',
    ok: mstHtlcDelta === -mstAmount,
    label: 'ERC20HTLC released the locked MST amount',
    detail: `vault delta ${mstHtlcDelta}`,
  });
  const ethHtlcDelta =
    nativeAmountOf(balances, 'arbitrum', 'htlc') -
    nativeAmountOf(locked, 'arbitrum', 'htlc');
  checks.push({
    id: 'R04',
    ok: ethHtlcDelta === -ethAmount,
    label: 'ETHHTLC released the locked ETH amount',
    detail: `vault delta ${ethHtlcDelta}`,
  });
  checks.push({
    id: 'R05',
    ok: !state.claims.arbitrum && !state.claims.ethereum,
    label: 'no claim was recorded in the recovery scenario',
    detail: 'both assets returned through refund()',
  });

  checks.forEach((check) => log.result(check.ok, `${check.id} ${check.label} — ${check.detail}`));
  printBalanceTable({ ...state, balances: { ...state.balances, final: balances } });
  state.finalChecks = checks;
  state.balances.final = balances;
  const ok = checks.every((check) => check.ok);
  log.result(ok, `recovery flow final checks: ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) throw new FlowError('Final recovery checks failed', recoveryHint(config, state));
  return { checks, balances };
}

function printBalanceTable(state) {
  const initial = state.balances.initial ?? {};
  const locked = state.balances.locked ?? initial;
  const final = state.balances.final ?? {};
  const decimals = tokenDecimals(final);
  const rows = [];

  const fmt = (value, unit) =>
    unit === 'mst'
      ? ethers.formatUnits(BigInt(value), decimals)
      : ethers.formatEther(BigInt(value));

  const mstInitial = initial?.ethereum?.mst;
  const mstLocked = locked?.ethereum?.mst;
  const mstFinal = final?.ethereum?.mst;
  if (mstInitial && mstFinal) {
    for (const who of ['alice', 'bob', 'htlc']) {
      const before = BigInt(mstInitial[who]);
      const atLock = BigInt(mstLocked?.[who] ?? before);
      const after = BigInt(mstFinal[who]);
      rows.push([
        'MST',
        who,
        fmt(before, 'mst'),
        fmt(atLock, 'mst'),
        fmt(after, 'mst'),
        fmt(after - before, 'mst'),
        fmt(after - atLock, 'mst'),
      ]);
    }
  }
  for (const chainKey of ['ethereum', 'arbitrum']) {
    for (const who of ['alice', 'bob', 'htlc']) {
      const before = BigInt(initial[chainKey].native[who]);
      const atLock = BigInt(locked[chainKey].native[who]);
      const after = BigInt(final[chainKey].native[who]);
      rows.push([
        `${chainKey === 'ethereum' ? 'ETH Sepolia' : 'Arb Sepolia'} ETH`,
        who,
        fmt(before, 'eth'),
        fmt(atLock, 'eth'),
        fmt(after, 'eth'),
        fmt(after - before, 'eth'),
        fmt(after - atLock, 'eth'),
      ]);
    }
  }
  log.table(rows, [
    'asset',
    'account',
    'initial',
    'locked',
    'final',
    'net (initial->final)',
    'release (locked->final)',
  ]);
}

function printSummary(config, state) {
  log.section('Transaction summary');
  const rows = [];
  const add = (step, chainKey, record) => {
    if (!record?.txHash) return;
    const chain = config.chains[chainKey];
    rows.push([
      step,
      chain.label,
      record.txHash,
      chain.explorer ? `${chain.explorer}/tx/${record.txHash}` : '(local)',
    ]);
  };

  add('approve MST', 'ethereum', state.approvals?.ethereum);
  add('lock MST', 'ethereum', state.swaps?.ethereum);
  add('lock ETH', 'arbitrum', state.swaps?.arbitrum);
  add('claim ETH', 'arbitrum', state.claims?.arbitrum);
  add('claim MST', 'ethereum', state.claims?.ethereum);
  add('refund ETH', 'arbitrum', state.refunds?.arbitrum);
  add('refund MST', 'ethereum', state.refunds?.ethereum);
  log.table(rows, ['step', 'chain', 'tx hash', 'explorer']);

  log.section('Outcome');
  log.info(`label: ${state.label}`);
  log.info(`status: ${state.status}`);
  log.info(`hashlock: ${state.hashlock}`);
  log.info(
    `ETH timelock: ${log.formatTimestamp(state.timelocks.eth)} | MST timelock: ${log.formatTimestamp(state.timelocks.mst)}`
  );
  if (state.claims?.arbitrum) log.info('ETH claimed by Alice; secret revealed on Arbitrum Sepolia');
  if (state.claims?.ethereum) log.info('MST claimed by Bob; atomic swap complete');
  if (state.refunds?.arbitrum) log.info('ETH refunded to Bob');
  if (state.refunds?.ethereum) log.info('MST refunded to Alice');
  log.info(`state file: .runtime/swaps/${state.label}.json`);
}

function safeSummary(state) {
  const swapSummary = {};
  for (const [chainKey, swap] of Object.entries(state.swaps ?? {})) {
    swapSummary[chainKey] = {
      chain: swap.chain,
      swapId: swap.swapId,
      txHash: swap.txHash,
      blockNumber: swap.blockNumber,
      sender: swap.sender,
      recipient: swap.recipient,
      token: swap.token,
      amount: swap.amount,
      timelock: swap.timelock,
    };
  }
  const claimSummary = {};
  for (const [chainKey, claim] of Object.entries(state.claims ?? {})) {
    claimSummary[chainKey] = {
      txHash: claim.txHash,
      blockNumber: claim.blockNumber,
    };
  }
  const refundSummary = {};
  for (const [chainKey, refund] of Object.entries(state.refunds ?? {})) {
    refundSummary[chainKey] = {
      txHash: refund.txHash,
      blockNumber: refund.blockNumber,
    };
  }
  return {
    label: state.label,
    scenario: state.scenario,
    network: state.network,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    hashlock: state.hashlock,
    secretFingerprint: log.fingerprint(state.secret),
    parties: state.parties,
    amounts: state.amounts,
    humanAmounts: state.humanAmounts,
    timelocks: state.timelocks,
    swaps: swapSummary,
    approvals: state.approvals ?? {},
    claims: claimSummary,
    refunds: refundSummary,
    checks: state.checks,
    negativeChecks: state.negativeChecks,
    finalChecks: state.finalChecks,
    balances: state.balances,
  };
}

module.exports = {
  FlowError,
  preflight,
  runSuccess,
  runRefund,
  recoveryHint,
  safeSummary,
  printSummary,
};
