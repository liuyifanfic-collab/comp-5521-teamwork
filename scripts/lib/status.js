'use strict';

/**
 * Two-chain state observation.
 *
 * The report and the live demo need to answer: active, claimable, claimed,
 * expired or refundable?  The contracts store only 0/1/2/3 and do not flip to
 * "expired"; this module derives expiry from each chain's own latest block
 * timestamp and shows which actions are valid for Alice and Bob.
 */

const { ethers } = require('ethers');
const log = require('./log');
const { readSwap, getTokenInfo } = require('./protocol');
const { getLatestTimestamp } = require('./chain');
const { sameAddress, deriveState, statusName } = require('./swap');

function actionFlags(state, swap, viewer) {
  return {
    claim:
      state.status === 1 &&
      !state.expired &&
      sameAddress(viewer, swap.recipient),
    refund:
      state.status === 1 &&
      state.expired &&
      sameAddress(viewer, swap.sender),
  };
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

async function collectOne(config, chainKey, swapId, viewers = []) {
  const chain = config.chains[chainKey];
  const result = {
    chain: chainKey,
    label: chain.label,
    chainId: chain.chainId,
    contract: chain.htlcAddress,
    explorer: chain.explorer,
    swapId: swapId ?? null,
    found: false,
  };
  if (!swapId) {
    result.reason = 'no swap ID for this chain yet';
    return result;
  }

  const [swap, latest] = await Promise.all([
    readSwap(config, chainKey, swapId),
    getLatestTimestamp(config, chainKey),
  ]);
  const state = deriveState(swap, latest.timestamp);

  result.found = swap.status !== 0;
  result.swap = {
    sender: swap.sender,
    recipient: swap.recipient,
    token: swap.token,
    amount: swap.amount.toString(),
    hashlock: swap.hashlock,
    timelock: swap.timelock,
    status: swap.status,
    statusName: statusName(swap.status),
  };
  result.chainTime = latest.timestamp;
  result.blockNumber = latest.blockNumber;
  result.derived = state;
  result.actions = {};
  for (const name of viewers) {
    const address = config.accounts[name]?.address;
    if (address) result.actions[name] = actionFlags(state, swap, address);
  }

  if (chain.kind === 'erc20') {
    const info = await getTokenInfo(config);
    result.token = {
      address: config.mstAddress,
      symbol: info.symbol,
      decimals: info.decimals,
      humanAmount: ethers.formatUnits(swap.amount, info.decimals),
    };
  } else {
    result.token = {
      address: ethers.ZeroAddress,
      symbol: 'ETH',
      decimals: 18,
      humanAmount: ethers.formatEther(swap.amount),
    };
  }

  return result;
}

async function collectStatus(config, options = {}) {
  const label = options.label ?? null;
  const state = options.state ?? null;
  const viewerNames = options.viewer
    ? [options.viewer]
    : ['alice', 'bob'].filter((name) => config.accounts[name]?.address);

  const ethSwapId =
    options.ethSwapId ?? state?.swaps?.ethereum?.swapId ?? null;
  const arbSwapId =
    options.arbSwapId ?? state?.swaps?.arbitrum?.swapId ?? null;

  const [ethereum, arbitrum] = await Promise.all([
    collectOne(config, 'ethereum', ethSwapId, viewerNames),
    collectOne(config, 'arbitrum', arbSwapId, viewerNames),
  ]);

  const payload = {
    network: config.network,
    label,
    observedAt: new Date().toISOString(),
    ethereum,
    arbitrum,
    crossChain: {
      hashlockMatch:
        ethereum.found && arbitrum.found
          ? ethereum.swap.hashlock.toLowerCase() ===
            arbitrum.swap.hashlock.toLowerCase()
          : null,
      ethBeforeMst:
        ethereum.found && arbitrum.found
          ? arbitrum.swap.timelock < ethereum.swap.timelock
          : null,
      gapSeconds:
        ethereum.found && arbitrum.found
          ? ethereum.swap.timelock - arbitrum.swap.timelock
          : null,
    },
  };
  return payload;
}

function printChain(result) {
  log.section(`${result.label} (chainId ${result.chainId})`);
  if (!result.swapId) {
    log.warn(result.reason);
    return;
  }
  log.info(`contract: ${result.contract}`);
  log.info(`swapId:   ${result.swapId}`);
  if (!result.found) {
    log.warn('getSwap returned zero/None — no swap with this ID on this chain');
    return;
  }

  const swap = result.swap;
  const state = result.derived;
  log.info(
    `status:   ${state.statusName} (${state.status})  |  derived: ${state.stateLabel}`
  );
  log.info(
    `parties:  sender ${swap.sender}  ->  recipient ${swap.recipient}`
  );
  log.info(
    `asset:    ${result.token.humanAmount} ${result.token.symbol}  (token ${result.token.address})`
  );
  log.info(`hashlock: ${swap.hashlock}`);
  log.info(
    `timelock: ${log.formatTimestamp(swap.timelock)}  (${
      state.status === 1
        ? log.formatRelative(swap.timelock, result.chainTime)
        : 'terminal state; deadline no longer actionable'
    })`
  );
  log.info(
    `chain time: ${log.formatTimestamp(result.chainTime)}  block ${result.blockNumber}`
  );

  if (state.status === 1) {
    if (state.expired) {
      log.info('claim window: closed (at/after timelock); refund is now valid');
    } else {
      log.info(
        `claim window: open for another ${log.formatDuration(state.remainingSeconds)}; refund is not yet valid`
      );
    }
  }

  for (const [name, actions] of Object.entries(result.actions ?? {})) {
    log.info(
      `actions for ${name}: claim=${yesNo(actions.claim)}, refund=${yesNo(actions.refund)}`
    );
  }

  if (result.explorer) {
    log.info(`explorer: ${result.explorer}/address/${result.contract}`);
  }
}

function printStatus(payload) {
  log.section(`Cross-chain swap status${payload.label ? `: ${payload.label}` : ''}`);
  log.info(`network: ${payload.network}; observed at ${payload.observedAt}`);
  printChain(payload.ethereum);
  printChain(payload.arbitrum);

  log.section('Cross-chain checks');
  if (payload.crossChain.hashlockMatch === null) {
    log.warn('hashlock comparison: not available (one side is missing)');
  } else {
    log.result(
      payload.crossChain.hashlockMatch,
      `hashlock match: ${yesNo(payload.crossChain.hashlockMatch)}`
    );
  }
  if (payload.crossChain.ethBeforeMst === null) {
    log.warn('timelock ordering: not available (one side is missing)');
  } else {
    log.result(
      payload.crossChain.ethBeforeMst,
      `T_ETH < T_MST: ${yesNo(payload.crossChain.ethBeforeMst)} (gap ${log.formatDuration(payload.crossChain.gapSeconds)})`
    );
  }
}

async function showStatus(config, options = {}) {
  const payload = await collectStatus(config, options);
  printStatus(payload);
  return payload;
}

async function showAllStatuses(config, options = {}) {
  const { listSwapLabels, readSwap: readState } = require('./state');
  const labels = listSwapLabels();
  if (labels.length === 0) {
    throw new Error('No saved swap scenarios in .runtime/swaps; run the success or refund flow first');
  }

  const rows = [];
  const payloads = [];
  for (const label of labels.slice(-20)) {
    const state = readState(label);
    if (!state) continue;
    try {
      const payload = await collectStatus(config, {
        label,
        state,
        viewer: options.viewer,
      });
      payloads.push(payload);
      rows.push([
        label,
        payload.ethereum.swap?.statusName ?? '-',
        payload.arbitrum.swap?.statusName ?? '-',
        payload.ethereum.derived?.stateLabel ?? '-',
        payload.arbitrum.derived?.stateLabel ?? '-',
        payload.ethereum.swap?.timelock
          ? log.formatTimestamp(payload.ethereum.swap.timelock)
          : '-',
      ]);
    } catch (error) {
      rows.push([label, 'error', 'error', '-', '-', error.message]);
    }
  }

  log.section('Saved swaps');
  log.table(rows, ['label', 'MST', 'ETH', 'MST derived', 'ETH derived', 'MST timelock']);
  return payloads;
}

module.exports = {
  collectOne,
  collectStatus,
  printStatus,
  showStatus,
  showAllStatuses,
};
