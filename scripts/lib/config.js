'use strict';

/**
 * Configuration for the two independent chains.
 *
 * The scripts never read a private key from a command-line argument.  Keys are
 * taken from `.env` (ignored by Git) or, in local mode only, derived from the
 * throw-away Hardhat mnemonic so that a clean checkout can run the full
 * two-chain rehearsal without any wallet.
 */

const { ethers } = require('ethers');
const { ROOT, env, envInt } = require('./env');
const { readDeployment, deploymentFile: deploymentPath } = require('./state');

const DEFAULT_LOCAL_MNEMONIC =
  'test test test test test test test test test test test junk';

const CHAIN_DEFS = {
  ethereum: {
    key: 'ethereum',
    short: 'eth',
    kind: 'erc20',
    label: 'Ethereum Sepolia',
    chainId: 11155111,
    chainIdEnv: 'SEPOLIA_CHAIN_ID',
    rpcEnv: 'SEPOLIA_RPC_URL',
    localRpcEnv: 'LOCAL_ETH_RPC_URL',
    localRpcDefault: 'http://127.0.0.1:8545',
    localChainIdEnv: 'LOCAL_ETH_CHAIN_ID',
    localChainIdDefault: 31337,
    htlcEnv: 'ERC20HTLC_ADDRESS',
    localHtlcEnv: 'LOCAL_ERC20HTLC_ADDRESS',
    explorer: 'https://sepolia.etherscan.io',
    nativeSymbol: 'ETH',
    assetSymbol: 'MST',
  },
  arbitrum: {
    key: 'arbitrum',
    short: 'arb',
    kind: 'eth',
    label: 'Arbitrum Sepolia',
    chainId: 421614,
    chainIdEnv: 'ARBITRUM_SEPOLIA_CHAIN_ID',
    rpcEnv: 'ARBITRUM_SEPOLIA_RPC_URL',
    localRpcEnv: 'LOCAL_ARB_RPC_URL',
    localRpcDefault: 'http://127.0.0.1:8546',
    localChainIdEnv: 'LOCAL_ARB_CHAIN_ID',
    localChainIdDefault: 421614,
    htlcEnv: 'ETHHTLC_ADDRESS',
    localHtlcEnv: 'LOCAL_ETHHTLC_ADDRESS',
    explorer: 'https://sepolia.arbiscan.io',
    nativeSymbol: 'ETH',
    assetSymbol: 'ETH',
  },
};

const CHAIN_ALIASES = {
  eth: 'ethereum',
  ethereum: 'ethereum',
  sepolia: 'ethereum',
  mst: 'ethereum',
  l1: 'ethereum',
  arb: 'arbitrum',
  arbitrum: 'arbitrum',
  'arbitrum-sepolia': 'arbitrum',
  arbitrumsepolia: 'arbitrum',
  l2: 'arbitrum',
};

function value(name, overrides, fallback = undefined) {
  if (overrides && overrides[name] !== undefined) return overrides[name];
  return env(name, fallback);
}

function normalizeAddress(address, label) {
  if (address === null || address === undefined || address === '') return null;
  if (!ethers.isAddress(address)) {
    throw new Error(`${label} is not a valid EVM address: "${address}"`);
  }
  return ethers.getAddress(address);
}

function parsePrivateKey(privateKey, label) {
  if (!privateKey) return null;
  let normalized = String(privateKey).trim();
  // MetaMask's "Show private key" dialog often shows 64 hex characters
  // without the 0x prefix; accept both forms and normalise before signing.
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) normalized = `0x${normalized}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(
      `${label} must be a 32-byte hex private key (64 hex characters, with or without 0x)`
    );
  }
  const wallet = new ethers.Wallet(normalized);
  return { privateKey: normalized, address: wallet.address };
}

function deriveAccount(mnemonic, index) {
  const wallet = ethers.HDNodeWallet.fromPhrase(
    mnemonic,
    undefined,
    `m/44'/60'/0'/0/${index}`
  );
  return { privateKey: wallet.privateKey, address: wallet.address };
}

function buildAccounts(config) {
  const local = config.network === 'local';
  const mnemonic = value('LOCAL_MNEMONIC', config.overrides, DEFAULT_LOCAL_MNEMONIC);
  const suffix = local ? 'LOCAL_' : '';
  const specs = [
    { name: 'deployer', index: 0 },
    { name: 'alice', index: 1 },
    { name: 'bob', index: 2 },
  ];

  const accounts = {};
  for (const spec of specs) {
    const upper = spec.name.toUpperCase();
    const keyName = `${suffix}${upper}_PRIVATE_KEY`;
    const addressName = `${suffix}${upper}_ADDRESS`;
    let privateKey = value(keyName, config.overrides);

    if (!privateKey && !local && spec.name === 'deployer') {
      privateKey = value('PRIVATE_KEY', config.overrides);
    }

    let source = privateKey ? `env ${keyName}` : null;
    let account = parsePrivateKey(privateKey, keyName);

    if (!account && local) {
      account = deriveAccount(mnemonic, spec.index);
      source = `local mnemonic (index ${spec.index})`;
    }

    const explicitAddress = normalizeAddress(
      value(addressName, config.overrides),
      addressName
    );

    accounts[spec.name] = {
      name: spec.name,
      address: account ? account.address : explicitAddress,
      privateKey: account ? account.privateKey : null,
      source: source ?? (explicitAddress ? `env ${addressName}` : null),
    };
  }

  return { accounts, mnemonic };
}

function getConfig(options = {}) {
  const network = (options.network || env('HTLC_NETWORK', 'testnet')).toLowerCase();
  if (!['testnet', 'local'].includes(network)) {
    throw new Error(`Network must be "testnet" or "local", got "${network}"`);
  }

  const overrides = options.overrides ?? {};
  const deployment = readDeployment(network);
  const local = network === 'local';

  const chains = {};
  for (const def of Object.values(CHAIN_DEFS)) {
    const configuredChainId = local
      ? envInt(def.localChainIdEnv, def.localChainIdDefault)
      : envInt(def.chainIdEnv, def.chainId);
    if (!local && configuredChainId !== def.chainId) {
      throw new Error(
        `${def.chainIdEnv}=${configuredChainId} does not match ${def.label} chain ID ${def.chainId}`
      );
    }
    const rpcUrl = local
      ? value(def.localRpcEnv, overrides, def.localRpcDefault)
      : value(def.rpcEnv, overrides);
    const depChain = deployment?.chains?.[def.key] ?? null;
    const envHtlc = value(local ? def.localHtlcEnv : def.htlcEnv, overrides);
    const htlcRaw = envHtlc || depChain?.contract || null;
    const htlcAddress = normalizeAddress(
      htlcRaw,
      `${def.label} HTLC address`
    );

    chains[def.key] = {
      key: def.key,
      short: def.short,
      kind: def.kind,
      label: local ? `${def.label.replace(/ Sepolia$/, '')} local` : def.label,
      chainId: local
        ? Number(value(def.localChainIdEnv, overrides, configuredChainId))
        : configuredChainId,
      rpcUrl: rpcUrl || null,
      explorer: local ? null : def.explorer,
      htlcAddress,
      htlcSource: envHtlc ? 'env' : depChain?.contract ? 'deployments file' : null,
      nativeSymbol: def.nativeSymbol,
      assetSymbol: def.assetSymbol,
    };
  }

  const mstEnvName = local ? 'LOCAL_MST_ADDRESS' : 'MST_ADDRESS';
  const mstEnv = value(mstEnvName, overrides);
  const mstRaw = mstEnv || deployment?.mstAddress || null;
  const mstAddress = normalizeAddress(mstRaw, 'MST address');

  const accounts = buildAccounts({ network, overrides });

  const timelocks = {
    mstSeconds: Number(value('MST_TIMELOCK_SECONDS', overrides, 1800)),
    ethSeconds: Number(value('ETH_TIMELOCK_SECONDS', overrides, 900)),
    minGapSeconds: Number(value('MIN_TIMELOCK_GAP_SECONDS', overrides, 300)),
  };
  for (const [name, seconds] of Object.entries(timelocks)) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`${name} must be a positive number of seconds`);
    }
  }
  if (timelocks.ethSeconds >= timelocks.mstSeconds) {
    throw new Error(
      `ETH_TIMELOCK_SECONDS (${timelocks.ethSeconds}) must be smaller than MST_TIMELOCK_SECONDS (${timelocks.mstSeconds})`
    );
  }
  if (timelocks.ethSeconds + timelocks.minGapSeconds > timelocks.mstSeconds) {
    throw new Error(
      `Timelock ordering is unsafe: ETH (${timelocks.ethSeconds}s) + safety gap (${timelocks.minGapSeconds}s) exceeds MST (${timelocks.mstSeconds}s)`
    );
  }

  return {
    root: ROOT,
    network,
    isLocal: local,
    deployment,
    deploymentFile: deploymentPath(network),
    chains,
    mstAddress,
    mstSource: mstEnv ? 'env' : deployment?.mstAddress ? 'deployments file' : null,
    accounts: accounts.accounts,
    mnemonic: accounts.mnemonic,
    amounts: {
      mst: value('MST_LOCK_AMOUNT', overrides, '100'),
      eth: value('ETH_LOCK_AMOUNT', overrides, '0.01'),
    },
    mstMintAmount: value('MST_MINT_AMOUNT', overrides, '1000000'),
    mstMintTo: value('MST_MINT_TO', overrides),
    timelocks,
    confirmations: Number(value('CONFIRMATIONS', overrides, 1)),
    txTimeoutMs: Number(value('TX_TIMEOUT_MS', overrides, 180000)),
    minNativeBalance: value(
      'MIN_NATIVE_BALANCE',
      overrides,
      local ? '0' : '0.001'
    ),
    overrides,
    providers: {},
    chainChecks: {},
  };
}

function resolveChainName(name) {
  if (!name) throw new Error('Missing --chain (use "eth" or "arb")');
  const key = CHAIN_ALIASES[String(name).toLowerCase()];
  if (!key) {
    throw new Error(`Unknown chain "${name}"; use "eth" (Ethereum Sepolia) or "arb" (Arbitrum Sepolia)`);
  }
  return key;
}

function otherChain(key) {
  return key === 'ethereum' ? 'arbitrum' : 'ethereum';
}

function describeAccount(account) {
  return {
    name: account.name,
    address: account.address,
    configured: Boolean(account.address),
    hasPrivateKey: Boolean(account.privateKey),
    source: account.source,
  };
}

module.exports = {
  DEFAULT_LOCAL_MNEMONIC,
  CHAIN_DEFS,
  getConfig,
  resolveChainName,
  otherChain,
  describeAccount,
  normalizeAddress,
};
