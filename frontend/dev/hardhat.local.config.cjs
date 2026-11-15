// C 本地联调用：在仓库根配置基础上，给本地节点指定 chainId 并开启定时出块
// （定时出块让链上时间持续前进，便于观察 timelock 到期与退款）。不修改 A 的 hardhat.config.js。
const path = require("path");
const base = require("../../hardhat.config.js");

module.exports = {
  ...base,
  paths: { root: path.resolve(__dirname, "../..") },
  networks: {
    ...base.networks,
    hardhat: {
      ...(base.networks && base.networks.hardhat),
      chainId: Number(process.env.CHAIN_ID || 31337),
      mining: { auto: true, interval: 2000 },
    },
  },
};
