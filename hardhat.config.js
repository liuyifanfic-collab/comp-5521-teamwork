// 仅用于本地编译与测试；不含双链网络、RPC、私钥与部署脚本。
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");

module.exports = {
  solidity: "0.8.28",
  networks: {
    hardhat: { allowBlocksWithSameTimestamp: true }
  }
};
