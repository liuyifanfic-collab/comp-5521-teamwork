# C 角色：HTLC 前端

Vite + 原生 JS + ethers v6。ABI 直接引用仓库根目录 `abi/` 下 A/B 的交付件，不修改合约。

## 本地双链 Mock 运行（无需 MetaMask、无需测试币）

在仓库根目录，开 3 个终端：

```bash
npm ci && npx hardhat compile
```

```bash
CHAIN_ID=31337 npx hardhat node --config frontend/dev/hardhat.local.config.cjs --port 8545
```

```bash
CHAIN_ID=31338 npx hardhat node --config frontend/dev/hardhat.local.config.cjs --port 8546
```

```bash
node frontend/dev/deploy-local.cjs
```

```bash
cd frontend && npm install && npm run dev
```

打开 <http://localhost:5173/?devwallet>。`?devwallet` 使用本地节点自带的已解锁测试账户（不含私钥），切换 Alice/Bob 标签页会自动切换账户。不加 `?devwallet` 则使用 MetaMask。

- 链 A（31337，8545）模拟 Ethereum Sepolia：MockMST + ERC20HTLC
- 链 B（31338，8546）模拟 Arbitrum Sepolia：ETHHTLC
- 每次重启节点后需重新运行 `deploy-local.cjs`，并点「开始新的交换」清空本地会话。

## 测试网

D 部署后复制 `.env.example` 为 `.env.local`，填写地址，`VITE_PROFILE=testnet`，然后 `npm run dev`，用 MetaMask 连接。

## 功能对应评分项

| 评分项 | 实现 |
|---|---|
| C1 钱包与网络 | 连接钱包、显示账户/网络、一键切换两条链（钱包未添加时自动 `wallet_addEthereumChain`） |
| C2 状态展示 | MST/ETH 余额、MST 授权额度、合约地址、swap 全字段、hashlock、timelock 倒计时、approve |
| C3 引导流程 | Alice：secret → approve/lock MST → 核验 ETH 锁 → claim ETH；Bob：核验 MST 锁 → lock ETH（强制 T2 < T1）→ 自动从 Claimed 事件读 secret → claim MST；过期后显示退款 |
| C4 反馈 | 交易记录（签名中 / 已广播 / 已确认 / 失败）、浏览器链接、自定义错误中文解码、完成/退款横幅 |

状态派生：链上 status 只有 None/Active/Claimed/Refunded，「可领取 / 已过期可退款」由 status + 该链最新区块时间 + 当前账户计算；两条链分别用独立的只读 RPC 读取。「仍然尝试」按钮会真实调用合约，用于演示合约拒绝无效操作（如到期前退款 → `SwapNotExpired`）。
