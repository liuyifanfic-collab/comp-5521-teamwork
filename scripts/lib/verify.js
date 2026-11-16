'use strict';

/**
 * Cross-chain parameter verification.
 *
 * This is the script-level equivalent of "verify the first lock before creating
 * the second one": it checks the hashlock, participants, asset markers, amounts
 * and, most importantly, that T_ETH < T_MST by at least the configured safety
 * margin.  It reads both chains independently; neither contract is asked to
 * look at the other chain.
 */

const { ethers } = require('ethers');
const log = require('./log');
const { readSwap, getTokenInfo } = require('./protocol');
const { assertChain, getLatestTimestamp, providerFor } = require('./chain');
const {
  sameAddress,
  deriveState,
  statusName,
} = require('./swap');

function add(checks, id, ok, label, detail = '') {
  checks.push({ id, ok: Boolean(ok), label, detail });
}

function fmtAmount(amount, decimals, symbol) {
  return `${ethers.formatUnits(amount, decimals)} ${symbol}`;
}

async function verifyPair(config, options) {
  const { mstId, ethId, secret, expected = {}, state = null } = options;
  if (!mstId) throw new Error('Missing MST swap ID for verification');
  if (!ethId) throw new Error('Missing ETH swap ID for verification');

  await assertChain(config, 'ethereum');
  await assertChain(config, 'arbitrum');

  const [mst, eth, mstTime, ethTime, token] = await Promise.all([
    readSwap(config, 'ethereum', mstId),
    readSwap(config, 'arbitrum', ethId),
    getLatestTimestamp(config, 'ethereum'),
    getLatestTimestamp(config, 'arbitrum'),
    getTokenInfo(config),
  ]);

  const checks = [];
  const mstFound = mst.status !== 0;
  const ethFound = eth.status !== 0;

  add(checks, 'V01', mstFound && ethFound, 'both swaps exist', `MST status ${mst.status}, ETH status ${eth.status}`);
  add(
    checks,
    'V02',
    mstFound && ethFound && mst.hashlock.toLowerCase() === eth.hashlock.toLowerCase(),
    'both locks share the same hashlock',
    `${mst.hashlock} vs ${eth.hashlock}`
  );

  if (secret) {
    const derived = ethers.keccak256(secret);
    add(
      checks,
      'V03',
      derived.toLowerCase() === mst.hashlock.toLowerCase(),
      'keccak256(secret) equals the hashlock',
      derived
    );
  }

  add(
    checks,
    'V04',
    sameAddress(mst.token, config.mstAddress),
    'MST lock uses the configured MST token',
    `${mst.token} vs ${config.mstAddress}`
  );
  add(
    checks,
    'V05',
    sameAddress(eth.token, ethers.ZeroAddress),
    'ETH lock uses address(0) as the asset marker',
    eth.token
  );
  add(
    checks,
    'V06',
    sameAddress(mst.sender, eth.recipient) && sameAddress(mst.recipient, eth.sender),
    'participants are mirrored across chains',
    `MST ${mst.sender}->${mst.recipient}; ETH ${eth.sender}->${eth.recipient}`
  );

  if (expected.mstAmount !== undefined) {
    add(
      checks,
      'V07a',
      mst.amount.toString() === expected.mstAmount.toString(),
      'MST amount matches the scenario',
      `${fmtAmount(mst.amount, token.decimals, token.symbol)} (expected ${fmtAmount(BigInt(expected.mstAmount), token.decimals, token.symbol)})`
    );
  }
  if (expected.ethAmount !== undefined) {
    add(
      checks,
      'V07b',
      eth.amount.toString() === expected.ethAmount.toString(),
      'ETH amount matches the scenario',
      `${ethers.formatEther(eth.amount)} ETH (expected ${ethers.formatEther(BigInt(expected.ethAmount))} ETH)`
    );
  }

  const gap = mst.timelock - eth.timelock;
  const minimumGap =
    expected.minGapSeconds ?? config.timelocks.minGapSeconds;
  add(
    checks,
    'V08',
    gap >= minimumGap,
    'T_ETH < T_MST with the configured safety gap',
    `ETH ${log.formatTimestamp(eth.timelock)} < MST ${log.formatTimestamp(mst.timelock)}, gap ${log.formatDuration(gap)} (minimum ${minimumGap}s)`
  );

  const expectedStatus = expected.status ?? 1;
  if (expectedStatus !== 'any') {
    add(
      checks,
      'V09',
      mst.status === expectedStatus && eth.status === expectedStatus,
      `both swaps have status ${statusName(expectedStatus)} (${expectedStatus})`,
      `MST ${statusName(mst.status)} (${mst.status}), ETH ${statusName(eth.status)} (${eth.status})`
    );
  }

  if (expectedStatus === 1) {
    add(
      checks,
      'V10',
      mstTime.timestamp < mst.timelock && ethTime.timestamp < eth.timelock,
      'both claim windows are still open',
      `MST ${log.formatRelative(mst.timelock, mstTime.timestamp)}; ETH ${log.formatRelative(eth.timelock, ethTime.timestamp)}`
    );
  }

  add(
    checks,
    'V11',
    config.chains.ethereum.chainId !== config.chains.arbitrum.chainId,
    'the two chains have distinct chain IDs',
    `${config.chains.ethereum.chainId} vs ${config.chains.arbitrum.chainId}`
  );

  if (config.chains.ethereum.htlcAddress) {
    add(
      checks,
      'V12a',
      sameAddress(mst.contract, config.chains.ethereum.htlcAddress),
      'MST swap belongs to the configured ERC20HTLC',
      config.chains.ethereum.htlcAddress
    );
  }
  if (config.chains.arbitrum.htlcAddress) {
    add(
      checks,
      'V12b',
      sameAddress(eth.contract, config.chains.arbitrum.htlcAddress),
      'ETH swap belongs to the configured ETHHTLC',
      config.chains.arbitrum.htlcAddress
    );
  }

  const mstTokenBalance = await (async () => {
    const tokenContract = new ethers.Contract(
      config.mstAddress,
      ['function balanceOf(address) view returns (uint256)'],
      providerFor(config, 'ethereum')
    );
    return tokenContract.balanceOf(config.chains.ethereum.htlcAddress);
  })();

  const ethContractBalance = await providerFor(config, 'arbitrum').getBalance(
    config.chains.arbitrum.htlcAddress
  );

  const activeCustody =
    expectedStatus === 1 ||
    (expectedStatus === 'any' && mst.status === 1 && eth.status === 1);

  if (activeCustody) {
    add(
      checks,
      'V13',
      mstTokenBalance >= mst.amount,
      'ERC20HTLC holds at least the locked MST amount',
      `${fmtAmount(mstTokenBalance, token.decimals, token.symbol)} vs ${fmtAmount(mst.amount, token.decimals, token.symbol)}`
    );
    add(
      checks,
      'V14',
      ethContractBalance >= eth.amount,
      'ETHHTLC holds at least the locked ETH amount',
      `${ethers.formatEther(ethContractBalance)} ETH vs ${ethers.formatEther(eth.amount)} ETH`
    );
  } else if (state?.balances?.locked) {
    const expectedMstVault =
      BigInt(state.balances.locked.ethereum.mst.htlc) - mst.amount;
    const expectedEthVault =
      BigInt(state.balances.locked.arbitrum.native.htlc) - eth.amount;
    add(
      checks,
      'V13',
      mstTokenBalance === expectedMstVault,
      'ERC20HTLC released the completed MST swap',
      `${fmtAmount(mstTokenBalance, token.decimals, token.symbol)} (expected ${fmtAmount(expectedMstVault, token.decimals, token.symbol)})`
    );
    add(
      checks,
      'V14',
      ethContractBalance === expectedEthVault,
      'ETHHTLC released the completed ETH swap',
      `${ethers.formatEther(ethContractBalance)} ETH (expected ${ethers.formatEther(expectedEthVault)} ETH)`
    );
  } else {
    add(
      checks,
      'V13',
      true,
      'ERC20HTLC custody check skipped for a completed swap without a locked snapshot',
      fmtAmount(mstTokenBalance, token.decimals, token.symbol)
    );
    add(
      checks,
      'V14',
      true,
      'ETHHTLC custody check skipped for a completed swap without a locked snapshot',
      `${ethers.formatEther(ethContractBalance)} ETH`
    );
  }

  if (state?.swaps) {
    for (const [chainKey, swap] of [
      ['ethereum', mst],
      ['arbitrum', eth],
    ]) {
      const saved = state.swaps[chainKey];
      if (!saved) {
        add(checks, `V15${chainKey}`, false, `saved ${chainKey} lock record exists`, 'missing from state file');
        continue;
      }
      const ok =
        sameAddress(saved.sender, swap.sender) &&
        sameAddress(saved.recipient, swap.recipient) &&
        sameAddress(saved.token, swap.token) &&
        saved.amount.toString() === swap.amount.toString() &&
        saved.hashlock.toLowerCase() === swap.hashlock.toLowerCase() &&
        Number(saved.timelock) === swap.timelock &&
        String(saved.swapId ?? '').toLowerCase() === swap.swapId.toLowerCase();
      add(
        checks,
        `V15${chainKey}`,
        ok,
        `saved ${chainKey} record matches on-chain state`,
        saved.swapId
      );
    }
  }

  const ok = checks.every((check) => check.ok);
  return {
    ok,
    checks,
    mst,
    eth,
    mstTime,
    ethTime,
    token,
    mstState: deriveState(mst, mstTime.timestamp),
    ethState: deriveState(eth, ethTime.timestamp),
  };
}

function printChecks(title, result) {
  log.section(title);
  for (const check of result.checks) {
    log.result(check.ok, `${check.id} ${check.label}${check.detail ? ` — ${check.detail}` : ''}`);
  }
  log.info(`overall: ${result.ok ? 'PASS' : 'FAIL'}`);
}

module.exports = { verifyPair, printChecks };
