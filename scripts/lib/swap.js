'use strict';

/**
 * Pure helpers for the swap domain: preimage generation, status derivation and
 * timelock planning.  Keeping these functions free of network calls makes the
 * state rules easy to test and to reuse from the UI team.
 */

const { ethers } = require('ethers');
const log = require('./log');

const STATUS_NAMES = ['None', 'Active', 'Claimed', 'Refunded'];

function newSecret() {
  return ethers.hexlify(ethers.randomBytes(32));
}

function assertBytes32(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be a 0x-prefixed 32-byte hex string`);
  }
  return value.toLowerCase();
}

function hashlockOf(secret) {
  return ethers.keccak256(assertBytes32(secret, 'secret'));
}

function sameAddress(a, b) {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function statusName(status) {
  return STATUS_NAMES[Number(status)] ?? `Unknown(${status})`;
}

/**
 * Derive the actionable state from the stored status and the chain's latest
 * block timestamp.  The contract stores only Active/Claimed/Refunded; expiry is
 * deliberately derived off-chain so a stale "expired" flag can never be
 * mistaken for a state transition.
 */
function deriveState(swap, now, viewer = null) {
  const status = Number(swap.status);
  const timelock = Number(swap.timelock);
  const active = status === 1;
  const expired = active && now >= timelock;
  const claimWindowOpen = active && now < timelock;

  return {
    status,
    statusName: statusName(status),
    expired,
    claimWindowOpen,
    claimable: claimWindowOpen,
    refundable: expired,
    canClaim:
      claimWindowOpen && viewer ? sameAddress(viewer, swap.recipient) : false,
    canRefund: expired && viewer ? sameAddress(viewer, swap.sender) : false,
    remainingSeconds: active ? timelock - now : null,
    stateLabel:
      status === 0
        ? 'not-found'
        : status === 1
          ? expired
            ? 'expired/refundable'
            : 'active/claimable'
          : status === 2
            ? 'claimed'
            : 'refunded',
  };
}

function planTimelocks(config, baseTimestamp) {
  const base = Number(baseTimestamp);
  const mst = base + config.timelocks.mstSeconds;
  const eth = base + config.timelocks.ethSeconds;
  if (eth >= mst) {
    throw new Error('ETH timelock must be strictly earlier than the MST timelock');
  }
  if (mst - eth < config.timelocks.minGapSeconds) {
    throw new Error(
      `Timelock gap ${mst - eth}s is smaller than the configured safety margin ${config.timelocks.minGapSeconds}s`
    );
  }
  return {
    base,
    mst,
    eth,
    mstSeconds: config.timelocks.mstSeconds,
    ethSeconds: config.timelocks.ethSeconds,
    gapSeconds: mst - eth,
  };
}

/**
 * Choose a timelock for a single manual lock.  When the MST lock already
 * exists, the ETH lock must finish at least the safety margin before it.
 */
function chooseManualTimelock({ config, chainKey, now, explicit, existingMst }) {
  if (explicit !== undefined && explicit !== null) {
    const value = Number(explicit);
    if (!Number.isFinite(value) || value <= now) {
      throw new Error(`--timelock must be a Unix timestamp later than ${now}`);
    }
    return value;
  }

  if (chainKey === 'ethereum') {
    return now + config.timelocks.mstSeconds;
  }

  const wanted = now + config.timelocks.ethSeconds;
  if (!existingMst) {
    log.warn(
      'Locking ETH before the MST lock: timelock ordering cannot be checked yet; run "verify" after the MST lock'
    );
    return wanted;
  }

  const latestAllowed =
    Number(existingMst.timelock) - config.timelocks.minGapSeconds;
  const value = Math.min(wanted, latestAllowed);
  if (value <= now + 5) {
    throw new Error(
      `Not enough time before the MST timelock ${log.formatTimestamp(existingMst.timelock)}; create a new MST lock with a later timelock`
    );
  }
  return value;
}

function parseMstAmount(value, decimals) {
  let amount;
  try {
    amount = ethers.parseUnits(String(value), decimals);
  } catch {
    throw new Error(`Invalid MST amount "${value}" for ${decimals} decimals`);
  }
  if (amount <= 0n) throw new Error('MST amount must be greater than zero');
  return amount;
}

function parseEthAmount(value) {
  let amount;
  try {
    amount = ethers.parseEther(String(value));
  } catch {
    throw new Error(`Invalid ETH amount "${value}"`);
  }
  if (amount <= 0n) throw new Error('ETH amount must be greater than zero');
  return amount;
}

function amountToHuman(amount, decimals) {
  return ethers.formatUnits(amount, decimals);
}

module.exports = {
  STATUS_NAMES,
  newSecret,
  assertBytes32,
  hashlockOf,
  sameAddress,
  statusName,
  deriveState,
  planTimelocks,
  chooseManualTimelock,
  parseMstAmount,
  parseEthAmount,
  amountToHuman,
};
