'use strict';

/**
 * Contract artefacts and revert decoding.
 *
 * Deployment uses A's/B's frozen handoff copies (`abi/*.abi.json` and
 * `abi/*.bytecode.txt`) when present, so D does not silently deploy a
 * different build.  If the handoff directory is missing (for example in a
 * trimmed submission archive), the compiled Hardhat artefact is used instead.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ethers } = require('ethers');
const { ROOT } = require('./env');

const ABI_DIR = path.join(ROOT, 'abi');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'contracts');

const CONTRACT_NAMES = {
  erc20: 'ERC20HTLC',
  eth: 'ETHHTLC',
};

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InvalidApprover(address approver)',
  'error ERC20InvalidReceiver(address receiver)',
  'error ERC20InvalidSender(address sender)',
];

const COMMON_ERROR_ABI = [
  'error ReentrancyGuardReentrantCall()',
  'error SafeERC20FailedOperation(address token)',
  'error OwnableUnauthorizedAccount(address account)',
];

const cache = { handoff: {}, artifacts: {} };

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function artifactPath(contractName) {
  return path.join(ARTIFACT_DIR, `${contractName}.sol`, `${contractName}.json`);
}

function contractNameFor(kind) {
  const name = CONTRACT_NAMES[kind];
  if (!name) throw new Error(`Unknown contract kind "${kind}"`);
  return name;
}

function loadArtifact(kind) {
  const name = contractNameFor(kind);
  if (cache.artifacts[name]) return cache.artifacts[name];

  const file = artifactPath(name);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing compiled artifact ${path.relative(ROOT, file)}; run "npm run compile" first`
    );
  }
  const artifact = readJson(file);
  const value = {
    name,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    deployedBytecode: artifact.deployedBytecode,
    source: file,
  };
  cache.artifacts[name] = value;
  return value;
}

function loadHandoff(kind) {
  const name = contractNameFor(kind);
  if (cache.handoff[name]) return cache.handoff[name];

  const abiFile = path.join(ABI_DIR, `${name}.abi.json`);
  const bytecodeFile = path.join(ABI_DIR, `${name}.bytecode.txt`);
  const hasHandoff = fs.existsSync(abiFile) && fs.existsSync(bytecodeFile);

  if (!hasHandoff) {
    const artifact = loadArtifact(kind);
    const value = { ...artifact, handoff: false };
    cache.handoff[name] = value;
    return value;
  }

  const abi = readJson(abiFile);
  const bytecode = fs.readFileSync(bytecodeFile, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]+$/.test(bytecode)) {
    throw new Error(`${bytecodeFile} does not contain 0x-prefixed creation bytecode`);
  }

  const value = {
    name,
    abi,
    bytecode,
    source: abiFile,
    bytecodeSource: bytecodeFile,
    handoff: true,
  };
  cache.handoff[name] = value;
  return value;
}

function getContractFactory(kind, signer) {
  const handoff = loadHandoff(kind);
  return new ethers.ContractFactory(handoff.abi, handoff.bytecode, signer);
}

function loadMockMst() {
  const file = path.join(ARTIFACT_DIR, 'mocks', 'MockMST.sol', 'MockMST.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      'Missing MockMST artifact; run "npm run compile" before the local demo'
    );
  }
  const artifact = readJson(file);
  return {
    name: 'MockMST',
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    source: file,
  };
}

function loadMySimpleToken() {
  const file = artifactPath('MySimpleToken');
  if (!fs.existsSync(file)) {
    throw new Error(
      'Missing MySimpleToken artifact; run "npm run compile" before deploying MST'
    );
  }
  const artifact = readJson(file);
  return {
    name: 'MySimpleToken',
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    source: file,
  };
}

function buildInterfaces() {
  const abis = [
    loadHandoff('erc20').abi,
    loadHandoff('eth').abi,
    ERC20_ABI,
    COMMON_ERROR_ABI,
  ];
  return abis.map((abi) => new ethers.Interface(abi));
}

function extractRevertData(error) {
  const candidates = [
    error?.data,
    error?.error?.data,
    error?.info?.error?.data,
    error?.revert?.data,
    error?.cause?.data,
    error?.error?.error?.data,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function formatArg(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && ethers.isAddress(value)) return value;
  return String(value);
}

function decodeError(error) {
  if (error?.revert?.name) {
    return {
      name: error.revert.name,
      args: [...(error.revert.args ?? [])].map(formatArg),
    };
  }

  const data = extractRevertData(error);
  if (!data) return null;

  for (const iface of buildInterfaces()) {
    try {
      const parsed = iface.parseError(data);
      if (parsed) {
        return {
          name: parsed.name,
          args: [...parsed.args].map(formatArg),
        };
      }
    } catch {
      // Try the next interface.
    }
  }
  return null;
}

const ERROR_HINTS = {
  SwapNotFound: 'The swap ID does not exist on this chain; check the ID and the selected network.',
  SwapNotActive: 'The swap is already claimed or refunded; only Active swaps can change state.',
  UnauthorizedReceiver: 'Only the recorded recipient can claim this swap.',
  UnauthorizedSender: 'Only the original sender can refund this swap.',
  SwapExpired: 'The claim window has closed; the sender may refund at/after the timelock.',
  SwapNotExpired: 'The timelock has not passed yet; a refund is only allowed at/after expiry.',
  InvalidSecret: 'The secret does not match keccak256(abi.encodePacked(secret)).',
  InvalidTimelock: 'The timelock must be strictly later than the current block timestamp.',
  InvalidAmount: 'The amount must be greater than zero.',
  InvalidHashlock: 'The hashlock must not be zero.',
  InvalidAddress: 'The recipient address must not be zero.',
  InvalidToken: 'The token address must not be zero.',
  UnexpectedEther: 'This contract only accepts value through lock(); direct transfers are rejected.',
  ETHTransferFailed: 'The ETH payment failed; state and escrow were rolled back.',
  SafeERC20FailedOperation: 'The token transfer failed (non-standard token or insufficient balance/allowance).',
  ReentrancyGuardReentrantCall: 'OpenZeppelin blocked a reentrant call.',
  ERC20InsufficientAllowance: 'The MST allowance is insufficient; approve the ERC20HTLC contract.',
  ERC20InsufficientBalance: 'The token balance is insufficient for this transfer.',
};

function describeError(error) {
  const decoded = decodeError(error);
  if (decoded) {
    const args = decoded.args.length ? `(${decoded.args.join(', ')})` : '()';
    const hint = ERROR_HINTS[decoded.name];
    return `${decoded.name}${args}${hint ? ` — ${hint}` : ''}`;
  }
  if (error?.shortMessage) return error.shortMessage;
  if (error?.reason) return error.reason;
  if (error?.message) return error.message;
  return String(error);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function stripMetadata(bytecode) {
  // Solidity appends CBOR metadata (starting with a2 64 "ipfs" 58 22) to the
  // creation bytecode.  The metadata hash changes with the compilation path
  // even when the executable code is identical, so compare the executable
  // prefix separately from the tail.
  const marker = 'a264697066735822';
  const index = bytecode.toLowerCase().indexOf(marker);
  return index === -1 ? bytecode.toLowerCase() : bytecode.toLowerCase().slice(0, index);
}

function checkHandoff() {
  const checks = [];
  for (const kind of Object.keys(CONTRACT_NAMES)) {
    const name = CONTRACT_NAMES[kind];
    const handoff = loadHandoff(kind);
    let artifact = null;
    try {
      artifact = loadArtifact(kind);
    } catch (error) {
      checks.push({
        name,
        ok: null,
        detail: error.message,
      });
      continue;
    }

    const abiEqual = JSON.stringify(handoff.abi) === JSON.stringify(artifact.abi);
    checks.push({
      name: `${name} ABI`,
      ok: abiEqual,
      detail: abiEqual ? 'handoff ABI matches compiled artifact' : 'ABI differs from compiled artifact',
    });

    const bytecodeEqual = handoff.bytecode.toLowerCase() === artifact.bytecode.toLowerCase();
    const prefixEqual = stripMetadata(handoff.bytecode) === stripMetadata(artifact.bytecode);
    checks.push({
      name: `${name} bytecode`,
      ok: bytecodeEqual || prefixEqual,
      detail: bytecodeEqual
        ? 'handoff bytecode matches compiled artifact'
        : prefixEqual
          ? 'executable bytecode matches; only Solidity metadata hash differs'
          : 'bytecode differs from compiled artifact',
    });
    checks.push({
      name: `${name} hashes`,
      ok: true,
      detail: `abi sha256 ${sha256(JSON.stringify(handoff.abi)).slice(0, 16)}…, bytecode sha256 ${sha256(handoff.bytecode).slice(0, 16)}…`,
    });
  }
  return checks;
}

module.exports = {
  ABI_DIR,
  ERC20_ABI,
  COMMON_ERROR_ABI,
  loadHandoff,
  loadArtifact,
  getContractFactory,
  loadMockMst,
  loadMySimpleToken,
  decodeError,
  describeError,
  checkHandoff,
  stripMetadata,
  sha256,
};
