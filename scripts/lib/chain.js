'use strict';

/**
 * Provider, signer and transaction helpers shared by every script.
 *
 * All writes go through sendTx(), which prints the transaction hash and
 * explorer link before waiting, checks the receipt status and reports the
 * decoded custom error on failure.  This is the only place that broadcasts a
 * transaction, so evidence always contains the hashes on both chains.
 */

const { ethers } = require('ethers');
const log = require('./log');
const { describeError, decodeError } = require('./artifacts');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function providerFor(config, chainKey) {
  const chain = config.chains[chainKey];
  if (!chain) throw new Error(`Unknown chain key "${chainKey}"`);
  if (!chain.rpcUrl) {
    throw new Error(
      `No RPC URL configured for ${chain.label}; set the matching RPC variable in .env`
    );
  }
  if (!config.providers[chainKey]) {
    // Disable the provider's 250 ms response cache.  After a transaction is
    // mined, the next transaction must see the new pending nonce immediately;
    // a stale cached nonce produces "nonce has already been used" on automine
    // chains such as Hardhat.
    config.providers[chainKey] = new ethers.JsonRpcProvider(
      chain.rpcUrl,
      chain.chainId,
      {
        cacheTimeout: -1,
        // Do not let ethers loop forever trying to detect the network when a
        // node is down. assertChain() performs an explicit eth_chainId check.
        staticNetwork: true,
      }
    );
  }
  return config.providers[chainKey];
}

async function assertChain(config, chainKey) {
  if (config.chainChecks[chainKey]) return config.chainChecks[chainKey];

  const chain = config.chains[chainKey];
  const provider = providerFor(config, chainKey);
  let actual;
  try {
    const chainIdHex = await provider.send('eth_chainId', []);
    actual = Number(BigInt(chainIdHex));
  } catch (error) {
    throw new Error(
      `Cannot reach ${chain.label} RPC at ${log.redactUrl(chain.rpcUrl)}: ${error.shortMessage ?? error.message}`
    );
  }

  if (actual !== Number(chain.chainId)) {
    throw new Error(
      `RPC ${log.redactUrl(chain.rpcUrl)} reports chain ID ${actual}, but ${chain.label} requires ${chain.chainId}. Refusing to continue.`
    );
  }

  const blockNumber = await provider.getBlockNumber();
  const check = { chainId: actual, blockNumber };
  config.chainChecks[chainKey] = check;
  return check;
}

async function assertContractCode(config, chainKey, address, label) {
  if (!address) throw new Error(`No ${label} address configured for ${config.chains[chainKey].label}`);
  const provider = providerFor(config, chainKey);
  const code = await provider.getCode(address);
  if (!code || code === '0x') {
    throw new Error(
      `${label} ${address} has no contract code on ${config.chains[chainKey].label}; check the address and network`
    );
  }
  return code;
}

function walletFor(config, chainKey, accountName) {
  const account = config.accounts[accountName];
  if (!account) throw new Error(`Unknown account "${accountName}"`);
  if (!account.privateKey) {
    throw new Error(
      `No private key configured for ${accountName.toUpperCase()}; set ${config.network === 'local' ? 'LOCAL_' : ''}${accountName.toUpperCase()}_PRIVATE_KEY in .env`
    );
  }
  return new ethers.Wallet(account.privateKey, providerFor(config, chainKey));
}

function explorerTx(chain, hash) {
  return chain.explorer ? `${chain.explorer}/tx/${hash}` : null;
}

function explorerAddress(chain, address) {
  return chain.explorer ? `${chain.explorer}/address/${address}` : null;
}

async function getLatestTimestamp(config, chainKey) {
  const provider = providerFor(config, chainKey);
  const blockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(blockNumber);
  if (!block) throw new Error(`Cannot read latest block on ${config.chains[chainKey].label}`);
  return { timestamp: Number(block.timestamp), blockNumber };
}

async function getNativeBalance(config, chainKey, address) {
  return providerFor(config, chainKey).getBalance(address);
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Broadcast a transaction and wait for the configured number of
 * confirmations.  `txPromise` is evaluated lazily so the caller can wrap the
 * original contract call in a descriptive label.
 */
async function sendTx(config, chainKey, label, txPromise) {
  const chain = config.chains[chainKey];
  log.step(label, `submitting transaction on ${chain.label}`);

  let tx;
  try {
    tx = await (typeof txPromise === 'function' ? txPromise() : txPromise);
  } catch (error) {
    throw new Error(`${label} failed before broadcast: ${describeError(error)}`);
  }

  const link = explorerTx(chain, tx.hash);
  log.info(`tx hash: ${tx.hash}${link ? `  ${link}` : ''}`);

  let receipt;
  try {
    receipt = await withTimeout(
      tx.wait(config.confirmations),
      config.txTimeoutMs,
      `Timed out waiting for ${label}; transaction ${tx.hash} may still confirm — check the explorer before retrying`
    );
  } catch (error) {
    throw new Error(`${label} was broadcast but confirmation failed: ${describeError(error)}`);
  }

  if (!receipt) {
    throw new Error(`${label}: no receipt returned for transaction ${tx.hash}`);
  }
  if (Number(receipt.status) !== 1) {
    throw new Error(`${label} reverted in block ${receipt.blockNumber} (tx ${tx.hash})`);
  }

  log.ok(
    `${label} confirmed in block ${receipt.blockNumber}, gas ${receipt.gasUsed.toString()}`
  );
  return receipt;
}

/**
 * Assert that a read-only call reverts with one of the expected custom errors.
 * `staticCall` is used so a negative test never spends gas or changes state.
 */
async function expectRevert(label, call, expectedNames = null) {
  try {
    const value = await call();
    log.fail(`${label}: expected a revert but the call succeeded (${String(value)})`);
    return { ok: false, name: null, detail: 'call succeeded unexpectedly' };
  } catch (error) {
    const decoded = decodeError(error);
    const name = decoded?.name ?? null;
    const detail = describeError(error);
    const expected = expectedNames
      ? Array.isArray(expectedNames)
        ? expectedNames
        : [expectedNames]
      : null;
    const ok = !expected || (name !== null && expected.includes(name));
    if (ok) log.ok(`${label}: reverted as expected -> ${detail}`);
    else log.fail(`${label}: reverted with an unexpected error -> ${detail}`);
    return { ok, name, detail };
  }
}

async function waitForTimestamp(config, chainKey, target, options = {}) {
  const chain = config.chains[chainKey];
  const provider = providerFor(config, chainKey);
  const fastForward = options.fastForward ?? config.isLocal;
  let latest = await getLatestTimestamp(config, chainKey);

  if (latest.timestamp >= Number(target)) {
    log.info(`${chain.label} is already at/after ${log.formatTimestamp(target)}`);
    return latest;
  }

  if (fastForward) {
    if (!config.isLocal) {
      throw new Error('Fast-forward is only available on the local Hardhat networks');
    }
    const delta = Number(target) - latest.timestamp + 1;
    log.step('Fast-forwarding local chain', `${chain.label} +${delta}s (test-only)`);
    await provider.send('evm_increaseTime', [delta]);
    await provider.send('evm_mine', []);
    latest = await getLatestTimestamp(config, chainKey);
    if (latest.timestamp < Number(target)) {
      throw new Error(
        `Fast-forward did not reach the target timestamp on ${chain.label} (${latest.timestamp} < ${target})`
      );
    }
    log.ok(`chain time is now ${log.formatTimestamp(latest.timestamp)}`);
    return latest;
  }

  log.step(
    'Waiting for timelock',
    `${chain.label} until ${log.formatTimestamp(target)} (${log.formatRelative(target, latest.timestamp)})`
  );
  const deadline =
    Date.now() + Math.max(config.txTimeoutMs, (Number(target) - latest.timestamp + 120) * 1000);

  while (latest.timestamp < Number(target)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${chain.label} to reach ${log.formatTimestamp(target)}`
      );
    }
    const remaining = Number(target) - latest.timestamp;
    log.info(
      `waiting ${log.formatDuration(remaining)} (latest ${log.formatTimestamp(latest.timestamp)})`
    );
    await sleep(Math.min(15000, Math.max(1000, remaining * 500)));
    latest = await getLatestTimestamp(config, chainKey);
  }

  log.ok(`${chain.label} reached ${log.formatTimestamp(latest.timestamp)}`);
  return latest;
}

function formatTokenAmount(amount, decimals, symbol) {
  return `${ethers.formatUnits(amount, decimals)} ${symbol}`;
}

module.exports = {
  sleep,
  providerFor,
  assertChain,
  assertContractCode,
  walletFor,
  explorerTx,
  explorerAddress,
  getLatestTimestamp,
  getNativeBalance,
  withTimeout,
  sendTx,
  expectRevert,
  waitForTimestamp,
  formatTokenAmount,
};
