// Local compile/test plus the two public testnets and two local nodes.
// Only the Hardhat network is used by `npm test`; the D scripts use plain
// ethers providers and read the same variables from .env.
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");

const { loadEnv } = require("./scripts/lib/env");

loadEnv();

const localMnemonic =
  process.env.LOCAL_MNEMONIC ||
  "test test test test test test test test test test test junk";

const deployerAccounts = process.env.DEPLOYER_PRIVATE_KEY
  ? [process.env.DEPLOYER_PRIVATE_KEY]
  : [];

const networks = {
  hardhat: {
    // Override this when starting the second local node:
    //   LOCAL_CHAIN_ID=421614 npx hardhat node --port 8546
    chainId: Number(process.env.LOCAL_CHAIN_ID || 31337),
    allowBlocksWithSameTimestamp: true,
  },
  localEth: {
    url: process.env.LOCAL_ETH_RPC_URL || "http://127.0.0.1:8545",
    accounts: { mnemonic: localMnemonic },
  },
  localArb: {
    url: process.env.LOCAL_ARB_RPC_URL || "http://127.0.0.1:8546",
    accounts: { mnemonic: localMnemonic },
  },
};

if (process.env.SEPOLIA_RPC_URL) {
  networks.sepolia = {
    url: process.env.SEPOLIA_RPC_URL,
    accounts: deployerAccounts,
  };
}

if (process.env.ARBITRUM_SEPOLIA_RPC_URL) {
  networks.arbitrumSepolia = {
    url: process.env.ARBITRUM_SEPOLIA_RPC_URL,
    accounts: deployerAccounts,
  };
}

module.exports = {
  solidity: "0.8.28",
  networks,
};
