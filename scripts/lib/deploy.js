'use strict';

/**
 * Deployment for the two independent networks.
 *
 * Testnet: (optional) MySimpleToken MST on Ethereum Sepolia, then ERC20HTLC on
 * Ethereum Sepolia and ETHHTLC on Arbitrum Sepolia.  If the team already has an
 * MST address, set MST_ADDRESS and skip deploy-mst.
 *
 * Local: the same contracts plus the official Lab 3 MST token on the local
 * Ethereum node, so the full two-chain workflow can be rehearsed without
 * faucets or real funds.  Unit tests still use MockMST separately.
 */

const { ethers } = require('ethers');
const log = require('./log');
const { loadHandoff, loadMySimpleToken, sha256 } = require('./artifacts');
const { assertChain, assertContractCode, walletFor, sendTx } = require('./chain');
const { readDeployment, writeDeployment } = require('./state');

function resolveDeployer(config) {
  const deployer = config.accounts.deployer;
  if (deployer?.privateKey) return 'deployer';
  if (config.accounts.alice?.privateKey) {
    log.warn('DEPLOYER_PRIVATE_KEY is not set; using ALICE_PRIVATE_KEY as the deployer');
    return 'alice';
  }
  throw new Error(
    'No deployer key configured; set DEPLOYER_PRIVATE_KEY or ALICE_PRIVATE_KEY for testnet, or use local mode'
  );
}

function emptyDeployment(network) {
  return {
    network,
    updatedAt: new Date().toISOString(),
    chainIds: {},
    mstAddress: null,
    mst: null,
    chains: {},
  };
}

function mergeDeployment(network, patch) {
  const current = readDeployment(network) ?? emptyDeployment(network);
  const next = {
    ...current,
    ...patch,
    chainIds: { ...(current.chainIds ?? {}), ...(patch.chainIds ?? {}) },
    chains: { ...(current.chains ?? {}), ...(patch.chains ?? {}) },
    updatedAt: new Date().toISOString(),
  };
  writeDeployment(network, next);
  return next;
}

async function deployOne(config, chainKey) {
  const chain = config.chains[chainKey];
  await assertChain(config, chainKey);
  const deployerName = resolveDeployer(config);
  const wallet = walletFor(config, chainKey, deployerName);
  const handoff = loadHandoff(chain.kind);

  log.section(`Deploy ${handoff.name} to ${chain.label}`);
  log.info(`deployer: ${wallet.address}`);
  log.info(`bytecode source: ${handoff.bytecodeSource ?? handoff.source}`);
  log.info(`bytecode sha256: ${sha256(handoff.bytecode)}`);

  const factory = new ethers.ContractFactory(handoff.abi, handoff.bytecode, wallet);
  const contract = await factory.deploy();
  const deploymentTx = contract.deploymentTransaction();
  if (!deploymentTx) throw new Error('ContractFactory did not return a deployment transaction');

  const receipt = await sendTx(
    config,
    chainKey,
    `Deploy ${handoff.name}`,
    Promise.resolve(deploymentTx)
  );
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  await assertContractCode(config, chainKey, address, handoff.name);

  const record = {
    name: handoff.name,
    contract: address,
    chainId: chain.chainId,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    deployer: wallet.address,
    explorer: chain.explorer,
    abiSha256: sha256(JSON.stringify(handoff.abi)),
    bytecodeSha256: sha256(handoff.bytecode),
    deployedAt: new Date().toISOString(),
  };
  log.ok(`${handoff.name} deployed at ${address}`);
  if (chain.explorer) log.info(`${chain.explorer}/address/${address}`);
  return record;
}

async function deployMstToken(config, options = {}) {
  const chainKey = 'ethereum';
  const chain = config.chains[chainKey];
  await assertChain(config, chainKey);

  if (config.mstAddress && !options.force) {
    throw new Error(
      `MST is already configured at ${config.mstAddress}; skip deploy-mst or pass --force to deploy another token`
    );
  }

  const deployerName = resolveDeployer(config);
  const wallet = walletFor(config, chainKey, deployerName);
  const artifact = loadMySimpleToken();

  log.section(`Deploy MySimpleToken (official Lab 3 MST) to ${chain.label}`);
  log.info(`deployer: ${wallet.address}`);
  log.info(`bytecode source: ${artifact.source}`);
  log.info(`bytecode sha256: ${sha256(artifact.bytecode)}`);

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const token = await factory.deploy();
  const tx = token.deploymentTransaction();
  if (!tx) throw new Error('MySimpleToken deployment transaction missing');
  const receipt = await sendTx(config, chainKey, 'Deploy MySimpleToken', Promise.resolve(tx));
  await token.waitForDeployment();
  const address = await token.getAddress();
  await assertContractCode(config, chainKey, address, 'MySimpleToken');

  const mintTo = options.mintTo ?? config.accounts.alice.address ?? wallet.address;
  if (!mintTo || !ethers.isAddress(mintTo)) {
    throw new Error('MST mint recipient is not a valid address');
  }
  const mintAmount =
    options.mintAmount ?? ethers.parseUnits(String(config.mstMintAmount ?? '1000000'), 18);
  let mintTxHash = null;
  if (mintAmount > 0n) {
    log.step('Mint MST', `${ethers.formatUnits(mintAmount, 18)} MST to ${mintTo}`);
    const mintReceipt = await sendTx(config, chainKey, 'Mint MySimpleToken', () =>
      token.mint(mintTo, mintAmount)
    );
    mintTxHash = mintReceipt.hash;
  }

  const record = {
    name: 'MySimpleToken',
    contract: address,
    chainId: chain.chainId,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    deployer: wallet.address,
    explorer: chain.explorer,
    mintTo,
    mintAmount: mintAmount.toString(),
    mintTxHash,
    abiSha256: sha256(JSON.stringify(artifact.abi)),
    bytecodeSha256: sha256(artifact.bytecode),
    deployedAt: new Date().toISOString(),
  };
  log.ok(`MySimpleToken deployed at ${address}`);
  log.info(`MST_ADDRESS=${address}`);
  if (chain.explorer) log.info(`${chain.explorer}/address/${address}`);
  return record;
}

async function deployNetwork(config, options = {}) {
  const requested = options.chains ?? ['ethereum', 'arbitrum'];
  const withMst = Boolean(options.withMst);
  if (withMst && !config.isLocal) {
    throw new Error(
      'Refusing to deploy a test token through the combined local deploy; use "deploy-mst" for the public testnet'
    );
  }

  const existing = readDeployment(config.network) ?? emptyDeployment(config.network);
  let mstRecord = null;
  if (config.isLocal && (withMst || !existing.mstAddress)) {
    mstRecord = await deployMstToken(config, {
      mintTo: config.accounts.alice.address,
      mintAmount: options.mintAmount,
      force: withMst,
    });
    mergeDeployment(config.network, {
      mstAddress: mstRecord.contract,
      mst: mstRecord,
      chainIds: { ethereum: config.chains.ethereum.chainId },
    });
    // Subsequent commands read the address from the deployment file.
  }

  const records = {};
  for (const chainKey of requested) {
    records[chainKey] = await deployOne(config, chainKey);
    mergeDeployment(config.network, {
      chainIds: { [chainKey]: config.chains[chainKey].chainId },
      chains: { [chainKey]: records[chainKey] },
    });
  }

  const deployment = readDeployment(config.network) ?? emptyDeployment(config.network);
  log.section('Deployment summary');
  if (deployment.mstAddress) log.info(`MST:        ${deployment.mstAddress}`);
  for (const [chainKey, record] of Object.entries(deployment.chains ?? {})) {
    log.info(`${config.chains[chainKey]?.label ?? chainKey}: ${record.contract} (${record.name})`);
  }
  log.info(`saved to ${config.isLocal ? '.runtime/local/deployments.json' : 'deployments/testnet.json'}`);

  return { deployment, records, mstRecord };
}

module.exports = {
  deployOne,
  deployMstToken,
  deployNetwork,
  mergeDeployment,
  emptyDeployment,
};
