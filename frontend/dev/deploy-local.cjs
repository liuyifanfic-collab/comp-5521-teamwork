// C 本地联调用部署脚本（不是 D 的正式部署脚本）。
// 链 A（模拟 Ethereum Sepolia）：MockMST + ERC20HTLC；链 B（模拟 Arbitrum Sepolia）：ETHHTLC。
// 使用 Hardhat 节点自带的已解锁测试账户发交易，不读取、不保存任何私钥。
// 用法（仓库根目录）：先 npx hardhat compile，再启动两条本地链，然后 node frontend/dev/deploy-local.cjs
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "../..");
const RPC_A = process.env.RPC_A || "http://127.0.0.1:8545";
const RPC_B = process.env.RPC_B || "http://127.0.0.1:8546";

function artifact(file, name) {
  const p = path.join(ROOT, "artifacts/contracts", file, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function deploy(signer, art, ...args) {
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  return c;
}

async function main() {
  const provA = new ethers.JsonRpcProvider(RPC_A);
  const provB = new ethers.JsonRpcProvider(RPC_B);
  const [netA, netB] = await Promise.all([provA.getNetwork(), provB.getNetwork()]);
  const accounts = await provA.send("eth_accounts", []);
  const alice = accounts[0];
  const bob = accounts[1];

  const deployerA = await provA.getSigner(alice);
  const deployerB = await provB.getSigner(alice);

  const mst = await deploy(deployerA, artifact("mocks/MockMST.sol", "MockMST"));
  const erc20htlc = await deploy(deployerA, artifact("ERC20HTLC.sol", "ERC20HTLC"));
  const ethhtlc = await deploy(deployerB, artifact("ETHHTLC.sol", "ETHHTLC"));

  // 给 Bob 也发一些 MST，方便两种角色互换测试
  await (await mst.mint(bob, ethers.parseUnits("1000", 18))).wait();

  const startA = await provA.getBlockNumber();
  const startB = await provB.getBlockNumber();

  const config = {
    profile: "local",
    mstChain: {
      chainId: Number(netA.chainId),
      name: "Local Chain A (模拟 Ethereum Sepolia)",
      rpcUrl: RPC_A,
      explorer: "",
      htlc: await erc20htlc.getAddress(),
      mst: await mst.getAddress(),
      deployBlock: startA,
    },
    ethChain: {
      chainId: Number(netB.chainId),
      name: "Local Chain B (模拟 Arbitrum Sepolia)",
      rpcUrl: RPC_B,
      explorer: "",
      htlc: await ethhtlc.getAddress(),
      deployBlock: startB,
    },
    testAccounts: { alice, bob },
  };

  const out = path.join(__dirname, "../src/config.local.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\n");
  console.log("Deployed. Config written to", path.relative(ROOT, out));
  console.log(JSON.stringify(config, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
