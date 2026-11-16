'use strict';

/**
 * Protocol primitives: lock, claim, refund and the balance/event helpers.
 *
 * The rule from A's handoff is enforced here: the swap ID is always taken from
 * the Locked event, never from a transaction's Solidity return value.  Every
 * lock is followed by a getSwap() read that must match the event before the
 * script proceeds.
 */

const { ethers } = require('ethers');
const log = require('./log');
const {
  ERC20_ABI,
  loadHandoff,
  describeError,
} = require('./artifacts');
const {
  providerFor,
  assertChain,
  assertContractCode,
  walletFor,
  sendTx,
  getLatestTimestamp,
  getNativeBalance,
} = require('./chain');
const {
  assertBytes32,
  hashlockOf,
  sameAddress,
} = require('./swap');

function htlcFor(config, chainKey, signerOrProvider) {
  const chain = config.chains[chainKey];
  if (!chain.htlcAddress) {
    throw new Error(`No HTLC address configured for ${chain.label}`);
  }
  const { abi } = loadHandoff(chain.kind);
  return new ethers.Contract(
    chain.htlcAddress,
    abi,
    signerOrProvider ?? providerFor(config, chainKey)
  );
}

function erc20For(config, signerOrProvider, address = config.mstAddress) {
  if (!address) throw new Error('No MST address configured');
  return new ethers.Contract(
    address,
    ERC20_ABI,
    signerOrProvider ?? providerFor(config, 'ethereum')
  );
}

async function getTokenInfo(config) {
  if (config.tokenInfo) return config.tokenInfo;
  if (!config.mstAddress) {
    throw new Error('No MST address configured; set MST_ADDRESS in .env or deploy the local MockMST');
  }
  await assertChain(config, 'ethereum');
  await assertContractCode(config, 'ethereum', config.mstAddress, 'MST token');
  const token = erc20For(config, providerFor(config, 'ethereum'));
  const [decimals, symbol] = await Promise.all([
    token.decimals(),
    token.symbol().catch(() => 'MST'),
  ]);
  config.tokenInfo = {
    address: config.mstAddress,
    decimals: Number(decimals),
    symbol: String(symbol),
  };
  if (config.tokenInfo.decimals !== 18) {
    log.warn(
      `MST reports ${config.tokenInfo.decimals} decimals; the project specification uses 18. Amounts will use the on-chain value.`
    );
  }
  return config.tokenInfo;
}

async function readSwap(config, chainKey, swapId) {
  assertBytes32(swapId, 'swapId');
  const chain = config.chains[chainKey];
  const htlc = htlcFor(config, chainKey);
  const result = await htlc.getSwap(swapId);
  return {
    swapId,
    chain: chainKey,
    chainId: chain.chainId,
    contract: chain.htlcAddress,
    sender: result[0],
    recipient: result[1],
    token: result[2],
    amount: result[3],
    hashlock: result[4],
    timelock: Number(result[5]),
    status: Number(result[6]),
  };
}

function parseEvent(receipt, contract, eventName) {
  const contractAddress = String(contract.target).toLowerCase();
  for (const entry of receipt.logs) {
    if (String(entry.address).toLowerCase() !== contractAddress) continue;
    try {
      const parsed = contract.interface.parseLog({
        topics: entry.topics,
        data: entry.data,
      });
      if (parsed && parsed.name === eventName) return parsed;
    } catch {
      // A log from another contract with the same address is impossible; skip
      // any entry this ABI cannot decode.
    }
  }
  return null;
}

function requireEvent(receipt, contract, eventName, label) {
  const event = parseEvent(receipt, contract, eventName);
  if (!event) {
    throw new Error(`${label}: no ${eventName} event found in tx ${receipt.hash}`);
  }
  return event;
}

function assertEqual(actual, expected, label) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function assertSwapMatchesRecord(swap, record, label) {
  assertEqual(swap.sender, record.sender, `${label} sender`);
  assertEqual(swap.recipient, record.recipient, `${label} recipient`);
  assertEqual(swap.token, record.token, `${label} token`);
  assertEqual(swap.amount.toString(), record.amount.toString(), `${label} amount`);
  assertEqual(swap.hashlock, record.hashlock, `${label} hashlock`);
  assertEqual(swap.timelock, record.timelock, `${label} timelock`);
  assertEqual(swap.status, 1, `${label} stored status (expected Active=1)`);
}

function lockedRecord(chainKey, chain, event, receipt) {
  const [swapId, sender, recipient, token, amount, hashlock, timelock] = event.args;
  return {
    chain: chainKey,
    chainId: chain.chainId,
    contract: chain.htlcAddress,
    swapId,
    sender,
    recipient,
    token,
    amount: amount.toString(),
    hashlock,
    timelock: Number(timelock),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    lockedAt: new Date().toISOString(),
  };
}

async function ensureAllowance(config, wallet) {
  const token = erc20For(config, wallet);
  const htlc = htlcFor(config, 'ethereum', wallet);
  const allowance = await token.allowance(wallet.address, htlc.target);
  if (allowance > 0n) {
    log.info(`existing MST allowance: ${allowance.toString()} (raw units)`);
  }
  return allowance;
}

async function approveMst(config, { account = 'alice', amount }) {
  await assertChain(config, 'ethereum');
  const wallet = walletFor(config, 'ethereum', account);
  const token = erc20For(config, wallet);
  const htlc = htlcFor(config, 'ethereum', wallet);
  const receipt = await sendTx(config, 'ethereum', 'Approve MST', () =>
    token.approve(htlc.target, amount)
  );
  const allowance = await token.allowance(wallet.address, htlc.target);
  if (allowance < amount) {
    throw new Error(
      `Approve transaction confirmed but allowance is still ${allowance.toString()} < ${amount.toString()}`
    );
  }
  return {
    chain: 'ethereum',
    owner: wallet.address,
    spender: htlc.target,
    amount: amount.toString(),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  };
}

async function lockMst(config, options) {
  const {
    account = 'alice',
    recipient = config.accounts.bob.address,
    amount,
    hashlock,
    timelock,
    autoApprove = true,
  } = options;

  await assertChain(config, 'ethereum');
  await assertContractCode(config, 'ethereum', config.chains.ethereum.htlcAddress, 'ERC20HTLC');
  const expectedToken = config.mstAddress;
  if (!expectedToken) throw new Error('No MST address configured');
  await assertContractCode(config, 'ethereum', expectedToken, 'MST token');

  const wallet = walletFor(config, 'ethereum', account);
  const token = erc20For(config, wallet);
  const htlc = htlcFor(config, 'ethereum', wallet);
  const info = await getTokenInfo(config);

  if (!recipient || recipient === ethers.ZeroAddress) {
    throw new Error('Recipient address must not be zero');
  }
  if (!amount || amount <= 0n) throw new Error('MST amount must be greater than zero');
  assertBytes32(hashlock, 'hashlock');

  const now = (await getLatestTimestamp(config, 'ethereum')).timestamp;
  if (Number(timelock) <= now) {
    throw new Error(
      `MST timelock ${log.formatTimestamp(timelock)} is not later than chain time ${log.formatTimestamp(now)}`
    );
  }

  const balance = await token.balanceOf(wallet.address);
  if (balance < amount) {
    throw new Error(
      `Insufficient MST balance for ${account}: have ${ethers.formatUnits(balance, info.decimals)}, need ${ethers.formatUnits(amount, info.decimals)}`
    );
  }

  let allowance = await token.allowance(wallet.address, htlc.target);
  let approvalRecord = null;
  if (allowance < amount) {
    if (!autoApprove) {
      throw new Error(
        `MST allowance ${allowance.toString()} is below ${amount.toString()}; run the approve command first or allow auto-approve`
      );
    }
    log.step(
      'Approving MST',
      `${ethers.formatUnits(amount, info.decimals)} ${info.symbol} for ${htlc.target}`
    );
    const approval = await sendTx(config, 'ethereum', 'Approve MST', () =>
      token.approve(htlc.target, amount)
    );
    approvalRecord = { txHash: approval.hash, blockNumber: approval.blockNumber };
    allowance = await token.allowance(wallet.address, htlc.target);
    if (allowance < amount) {
      throw new Error(
        `Approve transaction ${approval.hash} confirmed but allowance is still too low`
      );
    }
  }

  const receipt = await sendTx(config, 'ethereum', 'Lock MST', () =>
    htlc.lock(expectedToken, recipient, amount, hashlock, timelock)
  );
  const event = requireEvent(receipt, htlc, 'Locked', 'Lock MST');
  const [swapId, sender, eventRecipient, eventToken, eventAmount, eventHashlock, eventTimelock] =
    event.args;

  if (!sameAddress(sender, wallet.address)) throw new Error('Locked event sender is not the signer');
  if (!sameAddress(eventRecipient, recipient)) throw new Error('Locked event recipient mismatch');
  if (!sameAddress(eventToken, expectedToken)) throw new Error('Locked event token mismatch');
  if (eventAmount !== amount) throw new Error('Locked event amount mismatch');
  assertEqual(eventHashlock, hashlock, 'Locked event hashlock');
  if (Number(eventTimelock) !== Number(timelock)) throw new Error('Locked event timelock mismatch');

  const record = lockedRecord('ethereum', config.chains.ethereum, event, receipt);
  if (approvalRecord) record.approval = approvalRecord;
  const onchain = await readSwap(config, 'ethereum', swapId);
  assertSwapMatchesRecord(onchain, record, 'ERC20HTLC lock');
  if (!sameAddress(onchain.sender, wallet.address)) {
    throw new Error('Stored swap sender does not match the signer');
  }
  if (!sameAddress(onchain.recipient, recipient)) {
    throw new Error('Stored swap recipient does not match the requested recipient');
  }

  log.ok(
    `MST locked: swapId ${swapId}, amount ${ethers.formatUnits(amount, info.decimals)} ${info.symbol}, timelock ${log.formatTimestamp(timelock)}`
  );
  return record;
}

async function lockEth(config, options) {
  const {
    account = 'bob',
    recipient = config.accounts.alice.address,
    amount,
    hashlock,
    timelock,
  } = options;

  await assertChain(config, 'arbitrum');
  await assertContractCode(config, 'arbitrum', config.chains.arbitrum.htlcAddress, 'ETHHTLC');

  const wallet = walletFor(config, 'arbitrum', account);
  const htlc = htlcFor(config, 'arbitrum', wallet);

  if (!recipient || recipient === ethers.ZeroAddress) {
    throw new Error('Recipient address must not be zero');
  }
  if (!amount || amount <= 0n) throw new Error('ETH amount must be greater than zero');
  assertBytes32(hashlock, 'hashlock');

  const now = (await getLatestTimestamp(config, 'arbitrum')).timestamp;
  if (Number(timelock) <= now) {
    throw new Error(
      `ETH timelock ${log.formatTimestamp(timelock)} is not later than chain time ${log.formatTimestamp(now)}`
    );
  }

  const balance = await getNativeBalance(config, 'arbitrum', wallet.address);
  const minNative = ethers.parseEther(String(config.minNativeBalance ?? '0'));
  if (balance < amount + minNative) {
    throw new Error(
      `Insufficient ETH balance for ${account}: have ${ethers.formatEther(balance)} ETH, need ${ethers.formatEther(amount + minNative)} ETH for the lock plus the configured gas reserve`
    );
  }

  const receipt = await sendTx(config, 'arbitrum', 'Lock ETH', () =>
    htlc.lock(recipient, hashlock, timelock, { value: amount })
  );
  const event = requireEvent(receipt, htlc, 'Locked', 'Lock ETH');
  const [swapId, sender, eventRecipient, eventToken, eventAmount, eventHashlock, eventTimelock] =
    event.args;

  if (!sameAddress(sender, wallet.address)) throw new Error('Locked event sender is not the signer');
  if (!sameAddress(eventRecipient, recipient)) throw new Error('Locked event recipient mismatch');
  if (!sameAddress(eventToken, ethers.ZeroAddress)) {
    throw new Error('ETH Locked event token must be address(0)');
  }
  if (eventAmount !== amount) throw new Error('Locked event amount mismatch');
  assertEqual(eventHashlock, hashlock, 'Locked event hashlock');
  if (Number(eventTimelock) !== Number(timelock)) throw new Error('Locked event timelock mismatch');

  const record = lockedRecord('arbitrum', config.chains.arbitrum, event, receipt);
  const onchain = await readSwap(config, 'arbitrum', swapId);
  assertSwapMatchesRecord(onchain, record, 'ETHHTLC lock');
  if (!sameAddress(onchain.sender, wallet.address)) {
    throw new Error('Stored swap sender does not match the signer');
  }
  if (!sameAddress(onchain.recipient, recipient)) {
    throw new Error('Stored swap recipient does not match the requested recipient');
  }

  log.ok(
    `ETH locked: swapId ${swapId}, amount ${ethers.formatEther(amount)} ETH, timelock ${log.formatTimestamp(timelock)}`
  );
  return record;
}

async function claimSwap(config, chainKey, options) {
  const { swapId, secret, account } = options;
  const chain = config.chains[chainKey];
  const expectedAccount = chainKey === 'ethereum' ? 'bob' : 'alice';
  const signerName = account ?? expectedAccount;
  const wallet = walletFor(config, chainKey, signerName);
  const htlc = htlcFor(config, chainKey, wallet);
  const normalizedSecret = assertBytes32(secret, 'secret');
  const swap = await readSwap(config, chainKey, swapId);
  const now = (await getLatestTimestamp(config, chainKey)).timestamp;

  if (swap.status !== 1) {
    throw new Error(
      `Swap ${swapId} on ${chain.label} is ${swap.status === 2 ? 'already claimed' : swap.status === 3 ? 'already refunded' : 'not found'}; nothing to claim`
    );
  }
  if (!sameAddress(swap.recipient, wallet.address)) {
    throw new Error(
      `Claim must be sent by the recipient ${swap.recipient}; ${wallet.address} is not the recipient`
    );
  }
  if (now >= swap.timelock) {
    throw new Error(
      `Claim window closed at ${log.formatTimestamp(swap.timelock)}; current chain time is ${log.formatTimestamp(now)}`
    );
  }
  if (hashlockOf(normalizedSecret) !== swap.hashlock.toLowerCase()) {
    throw new Error('The supplied secret does not match the swap hashlock');
  }

  const receipt = await sendTx(config, chainKey, `Claim ${chain.assetSymbol}`, () =>
    htlc.claim(swapId, normalizedSecret)
  );
  const event = requireEvent(receipt, htlc, 'Claimed', `Claim ${chain.assetSymbol}`);
  const [eventSwapId, eventSecret] = event.args;
  assertEqual(eventSwapId, swapId, 'Claimed event swapId');
  assertEqual(eventSecret, normalizedSecret, 'Claimed event secret');

  const after = await readSwap(config, chainKey, swapId);
  if (after.status !== 2) throw new Error(`Swap ${swapId} is not Claimed after the transaction`);

  log.ok(`Claim complete on ${chain.label}; secret revealed by the Claimed event`);
  return {
    chain: chainKey,
    chainId: chain.chainId,
    contract: chain.htlcAddress,
    swapId,
    recipient: wallet.address,
    secret: normalizedSecret,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    claimedAt: new Date().toISOString(),
  };
}

async function refundSwap(config, chainKey, options) {
  const { swapId, account } = options;
  const chain = config.chains[chainKey];
  const expectedAccount = chainKey === 'ethereum' ? 'alice' : 'bob';
  const signerName = account ?? expectedAccount;
  const wallet = walletFor(config, chainKey, signerName);
  const htlc = htlcFor(config, chainKey, wallet);
  const swap = await readSwap(config, chainKey, swapId);
  const now = (await getLatestTimestamp(config, chainKey)).timestamp;

  if (swap.status !== 1) {
    throw new Error(
      `Swap ${swapId} on ${chain.label} is ${swap.status === 2 ? 'already claimed' : swap.status === 3 ? 'already refunded' : 'not found'}; nothing to refund`
    );
  }
  if (!sameAddress(swap.sender, wallet.address)) {
    throw new Error(
      `Refund must be sent by the sender ${swap.sender}; ${wallet.address} is not the sender`
    );
  }
  if (now < swap.timelock) {
    throw new Error(
      `Refund not available before ${log.formatTimestamp(swap.timelock)}; current chain time is ${log.formatTimestamp(now)} (${log.formatRelative(swap.timelock, now)})`
    );
  }

  const receipt = await sendTx(config, chainKey, `Refund ${chain.assetSymbol}`, () =>
    htlc.refund(swapId)
  );
  const event = requireEvent(receipt, htlc, 'Refunded', `Refund ${chain.assetSymbol}`);
  assertEqual(event.args[0], swapId, 'Refunded event swapId');

  const after = await readSwap(config, chainKey, swapId);
  if (after.status !== 3) throw new Error(`Swap ${swapId} is not Refunded after the transaction`);

  log.ok(`Refund complete on ${chain.label}`);
  return {
    chain: chainKey,
    chainId: chain.chainId,
    contract: chain.htlcAddress,
    swapId,
    sender: wallet.address,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    refundedAt: new Date().toISOString(),
  };
}

async function tokenBalances(config) {
  const info = await getTokenInfo(config);
  const token = erc20For(config, providerFor(config, 'ethereum'));
  const htlc = config.chains.ethereum.htlcAddress;
  const [alice, bob, vault] = await Promise.all([
    token.balanceOf(config.accounts.alice.address),
    token.balanceOf(config.accounts.bob.address),
    htlc ? token.balanceOf(htlc) : 0n,
  ]);
  return {
    decimals: info.decimals,
    symbol: info.symbol,
    alice: alice.toString(),
    bob: bob.toString(),
    htlc: vault.toString(),
  };
}

async function nativeBalances(config, chainKey) {
  const chain = config.chains[chainKey];
  const [alice, bob, htlc] = await Promise.all([
    config.accounts.alice.address
      ? getNativeBalance(config, chainKey, config.accounts.alice.address)
      : 0n,
    config.accounts.bob.address
      ? getNativeBalance(config, chainKey, config.accounts.bob.address)
      : 0n,
    chain.htlcAddress ? getNativeBalance(config, chainKey, chain.htlcAddress) : 0n,
  ]);
  return {
    symbol: chain.nativeSymbol,
    alice: alice.toString(),
    bob: bob.toString(),
    htlc: htlc.toString(),
  };
}

async function snapshotBalances(config) {
  const snapshot = {};
  if (config.mstAddress) {
    snapshot.ethereum = { mst: await tokenBalances(config) };
  }
  snapshot.ethereum = {
    ...(snapshot.ethereum ?? {}),
    native: await nativeBalances(config, 'ethereum'),
  };
  snapshot.arbitrum = { native: await nativeBalances(config, 'arbitrum') };
  return snapshot;
}

function describeSwap(swap) {
  return {
    swapId: swap.swapId,
    sender: swap.sender,
    recipient: swap.recipient,
    token: swap.token,
    amount: swap.amount.toString(),
    hashlock: swap.hashlock,
    timelock: swap.timelock,
    status: swap.status,
  };
}

module.exports = {
  htlcFor,
  erc20For,
  getTokenInfo,
  readSwap,
  parseEvent,
  requireEvent,
  lockedRecord,
  ensureAllowance,
  approveMst,
  lockMst,
  lockEth,
  claimSwap,
  refundSwap,
  tokenBalances,
  nativeBalances,
  snapshotBalances,
  describeSwap,
  describeError,
};
