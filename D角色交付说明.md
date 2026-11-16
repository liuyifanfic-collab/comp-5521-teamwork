# D 角色交付说明

## 0. 分工与范围

按组内分工图（`7212aa4085ccc4f493b7db866ccb8aed.jpg`），**D = 跨链脚本与部署：双网络配置、secret/hashlock 生成、部署、参数检查、状态查询、成功流程与退款流程**。它对应课程任务书中的 **Task B1–B4**，不是任务书里名为 “Task D: Report and Presentation” 的报告角色。

本交付不修改 A 的 `ERC20HTLC`、B 的 `ETHHTLC` 及其冻结接口；只读取 `contracts/`、`abi/`，并以 A/B 的 handoff 为部署基准。组内没有 Sepolia MST，因此新增 `deploy-mst`，按课程 Lab 3 官方 `MySimpleToken` 部署了一个 MST。2026-11-16 已在真实 Ethereum Sepolia + Arbitrum Sepolia 完成部署、成功 swap 和超时退款 swap；本地双链另有一套可复现证据。

## 1. 产物

| 文件 | 用途 |
|---|---|
| `scripts/cli.js` | 统一命令入口：`doctor/deploy-mst/deploy/secret/approve/lock/verify/status/claim/refund/success/refund-flow/check-artifacts` |
| `scripts/lib/config.js` | 双网络配置、账户解析、chainId 校验、timelock 规则 |
| `scripts/lib/env.js` | 无额外依赖的 `.env` 读取（真实环境变量优先） |
| `scripts/lib/artifacts.js` | A/B ABI/bytecode handoff 读取、artifact 回退、自定义错误解码 |
| `scripts/lib/chain.js` | provider、签名者、chainId 校验、确认等待、explorer 链接、时间推进 |
| `scripts/lib/protocol.js` | `lock/claim/refund/getSwap`、事件解析、事件字段核对 |
| `scripts/lib/verify.js` | 跨链参数检查 V01–V15 |
| `scripts/lib/status.js` | 双链状态读取、`Active/Claimed/Refunded` + 到期派生状态、双方可执行动作 |
| `scripts/lib/deploy.js` | 无参部署两个 HTLC；本地额外部署官方 Lab 3 MySimpleToken；测试网可用 `deploy-mst` 单独部署 MST |
| `scripts/lib/flows.js` | 成功流程、超时退款流程、最终余额/状态断言、失败恢复提示 |
| `contracts/MySimpleToken.sol` | 官方 COMP5521 Lab 3 MST 代币（名称 My Simple Token / MST，18 decimals，owner mint） |
| `scripts/local/nodes.js` | 启动/停止/检查两个本地 Hardhat 节点 |
| `scripts/local-demo.js` | 一条命令完成本地双链部署 + 成功流程 + 退款流程，并生成证据 |
| `.env.example` | 双网络、账户、地址、金额、timelock、确认数模板（仅占位符） |
| `hardhat.config.js` | 在 A/B 配置上增加 Sepolia、Arbitrum Sepolia、两个本地网络 |
| `package.json` | 增加 `doctor/deploy:mst/deploy/swap:success/swap:refund/local:demo` 等 npm 脚本 |
| `deployments/README.md` | 测试网部署记录说明；`deployments/testnet.json` 由 `deploy-mst` + `deploy` 生成 |
| `evidence/d-local-two-chain.txt` | 本地双链成功 + 退款运行输出 |
| `evidence/d-local-two-chain.json` | 同一次运行的机器可读摘要（不含 secret/私钥） |
| `evidence/d-testnet-readonly.txt` | 部署后真实 RPC/chainId/余额/READY 的只读检查 |
| `evidence/d-testnet-success.txt` | 真实成功 swap 完整输出（F01–F05 PASS） |
| `evidence/d-testnet-refund.txt` | 真实超时退款完整输出（R01–R05 PASS） |
| `evidence/d-testnet-runs.json` | 两次真实运行的机器可读摘要（不含 secret/私钥） |
| `README.md` | 项目级安装、测试网部署、命令与演示流程 |

## 2. 双网络配置

| 项 | Ethereum Sepolia | Arbitrum Sepolia |
|---|---|---|
| 用途 | MST（ERC20） | 原生 ETH |
| 合约 | `ERC20HTLC` | `ETHHTLC` |
| chainId | `11155111` | `421614` |
| RPC | `SEPOLIA_RPC_URL` | `ARBITRUM_SEPOLIA_RPC_URL` |
| 合约地址 | `ERC20HTLC_ADDRESS` 或 `deployments/testnet.json` | `ETHHTLC_ADDRESS` 或 `deployments/testnet.json` |
| MST 地址 | `MST_ADDRESS`（已有地址）；若组里没有，运行 `npm run deploy:mst` 部署官方 Lab 3 `MySimpleToken` | 不适用 |
| explorer | `sepolia.etherscan.io` | `sepolia.arbiscan.io` |
| 参与方 | Alice 锁 MST，Bob 领取 MST | Bob 锁 ETH，Alice 领取 ETH |

账户：

- `ALICE_PRIVATE_KEY`：MST 持有者 / ETH 接收方；MetaMask 导出的 64 位私钥可直接用，`0x` 前缀可加可不加。
- `BOB_PRIVATE_KEY`：ETH 持有者 / MST 接收方；必须是和 Alice 不同的账户。
- `DEPLOYER_PRIVATE_KEY`：可选；缺省时 `deploy` 使用 Alice。
- `MST_MINT_TO` / `MST_MINT_AMOUNT`：仅 `deploy-mst` 使用；默认把 1,000,000 MST 铸给 Alice。
- 两个账户需要在两条链上都有 gas；Bob 在 Arbitrum 还需要 `ETH_LOCK_AMOUNT + gas`。
- 只读命令可以用 `ALICE_ADDRESS` / `BOB_ADDRESS`，但 `success` / `refund-flow` 必须有两把私钥。
- 可以用 MetaMask 账户：新建两个 disposable 测试网账户，在 *Account details → Show private key* 导出 64 位私钥填入 `.env`；`0x` 前缀可有可无。不要用主网账户，也不要把私钥发到聊天/仓库。

默认参数：

```text
MST_LOCK_AMOUNT=100
ETH_LOCK_AMOUNT=0.01
ETH_TIMELOCK_SECONDS=900
MST_TIMELOCK_SECONDS=1800
MIN_TIMELOCK_GAP_SECONDS=300
CONFIRMATIONS=1
```

必须满足 `ETH_TIMELOCK_SECONDS + MIN_TIMELOCK_GAP_SECONDS <= MST_TIMELOCK_SECONDS`；配置在启动时就会拒绝不安全的组合。`T_ETH < T_MST` 的实际链上值还会在 `verify` 中再次检查。

## 3. 脚本设计要点

1. **两条链完全独立**：所有读写都走各自 RPC；脚本不假设任一 HTLC 能读取另一条链，也没有 bridge/relayer/oracle。
2. **部署基准固定**：优先使用 `abi/ERC20HTLC.abi.json` + `abi/ERC20HTLC.bytecode.txt`、`abi/ETHHTLC.*`；缺少 handoff 时才回退到 `artifacts/`。`check-artifacts` 会把 handoff 与本地编译产物比较。当前 ERC20 handoff 与本地编译只在 Solidity metadata hash 上有差异（可执行 bytecode 相同），ETHHTLC 完全一致。
3. **swapId 只从事件取**：`lock` 后解析 `Locked` 事件，再立刻 `getSwap` 核对 sender/recipient/token/amount/hashlock/timelock/status；不读交易返回值。
4. **claim secret 从事件确认**：`Claimed(swapId, secret)` 的 secret 必须与本地 preimage 一致；`status` 和后续 claim 使用同一个 secret。
5. **写前检查 chainId**：任何写交易前都先 `eth_chainId` 对比配置；RPC 指错链时直接拒绝，不广播。
6. **确认与链接**：每笔交易在广播前打印 hash 和 explorer 链接，等待 `CONFIRMATIONS` 个确认并检查 receipt status。
7. **错误解码**：识别 A/B 的 14 个错误、`ETHTransferFailed`、OZ 的 `ReentrancyGuardReentrantCall`、`SafeERC20FailedOperation` 以及常见 ERC20 错误；无法识别时保留通用 revert 文本。
8. **secret 安全**：preimage 只写入 `.runtime/swaps/<label>.json`（0600），`.runtime/` 被 `.gitignore` 忽略；默认只打印 fingerprint，`--show-secret` 才打印全文。私钥只从 `.env` 读取，不进入命令行、日志或状态文件。
9. **状态派生**：合约只存 `0 None / 1 Active / 2 Claimed / 3 Refunded`；脚本用各自链最新区块时间派生 `active/claimable`、`expired/refundable`，并分别显示 Alice/Bob 的 `claim` / `refund` 是否可执行。`Active` 到期后不会自动变成 `Refunded`。
10. **确认数/缓存**：provider 关闭 ethers 默认 250ms 响应缓存，避免刚 mined 的交易在 Hardhat automine 链上取到旧 nonce（“nonce has already been used”）。
11. **失败不自动替用户退款**：流程失败会保存状态并打印状态相关恢复命令；是否退款、何时退款由用户/演示者决定，避免在未到期时误操作。

脚本输出与证据中的时间均为 UTC ISO-8601（例如 `2026-11-16T05:23:03.000Z`）；演示机器若在 UTC+8，请自行换算。

## 4. 命令

```bash
# 配置/连通性/ABI 检查
node scripts/cli.js doctor
node scripts/cli.js check-artifacts

# 部署 MST（仅当组里没有 Sepolia MST 地址）
node scripts/cli.js deploy-mst

# 部署（测试网：两个 HTLC；本地：MySimpleToken + 两个 HTLC）
node scripts/cli.js deploy
node scripts/cli.js deploy --network local --with-mst

# 手工流程
node scripts/cli.js secret --label demo --mst-amount 100 --eth-amount 0.01
node scripts/cli.js approve --amount 100
node scripts/cli.js lock --chain eth --label demo
node scripts/cli.js lock --chain arb --label demo
node scripts/cli.js verify --label demo
node scripts/cli.js status --label demo
node scripts/cli.js claim --chain arb --label demo
node scripts/cli.js claim --chain eth --label demo

# 自动成功流程
node scripts/cli.js success --label demo-success
node scripts/cli.js status --label demo-success

# 自动超时退款流程
node scripts/cli.js refund-flow --label demo-refund

# 本地一键双链演练
node scripts/local-demo.js
```

常用参数：

- `--network testnet|local`：默认 `testnet`。
- `--chain eth|arb`：单链操作。
- `--label <name>`：对应 `.runtime/swaps/<name>.json`；`status` 不传时使用最近一个。
- `--json`：stdout 只输出 JSON，进度写 stderr。
- `--env-file <path>`：指定配置文件。
- `--dry-run`：`success` / `refund-flow` 只做 preflight + timelock 计划，不发交易。
- `--fast-forward`：仅本地 `refund` 使用，调用 `evm_increaseTime` + `evm_mine` 推进到 timelock；公共测试网禁止。
- `--mst-seconds` / `--eth-seconds` / `--min-gap`：缩短 timelock 进行演练；必须保持安全顺序。
- `--evidence <file>`：把不含 secret 的流程摘要写成 JSON。

## 5. 成功流程（Task B2）

`success` 的实际步骤：

1. 读取两链最新区块时间，取 `base = max(now_eth, now_arb)`，生成 `T_MST = base + MST_TIMELOCK_SECONDS`、`T_ETH = base + ETH_TIMELOCK_SECONDS`，要求 `T_ETH + gap <= T_MST`。
2. preflight：链 ID、HTLC 合约字节码、MST 合约/decimals、Alice MST 余额、两方两条链 gas、Bob 的 `ETH_LOCK_AMOUNT + gas`。
3. **先锁 MST**（Alice，`T_MST`）：如 allowance 不足自动 `approve` 精确金额；解析 `Locked`，再用 `getSwap` 核对。
4. **再锁 ETH**（Bob，`T_ETH`）：`msg.value = ETH_LOCK_AMOUNT`，解析 `Locked`，再用 `getSwap` 核对。
5. `verify` V01–V15：同 hashlock、`keccak256(secret)`、MST token、ETH token=0、双方镜像、金额、`T_ETH < T_MST`、状态、两条链不同 chainId、合约地址、金库余额、状态文件与链上记录一致。
6. **Alice 在 Arbitrum claim ETH**：`Claimed` 事件公开 secret；脚本核对事件 secret。
7. **Bob 在 Ethereum claim MST**：使用同一 secret；核对事件与终态。
8. 最终检查：两边 `status=2 Claimed`；MST 从 Alice 到 Bob 恰好一次；ERC20HTLC 释放锁定额；ETHHTLC 释放锁定额；两次 `Claimed` 的 secret 相同且匹配 hashlock。
9. 输出每笔交易 hash（测试网带 explorer 链接）和最终余额表（initial / locked / final / net / release）。

## 6. 退款流程（Task B4）

`refund-flow` 的实际步骤：

1. 按同样方式锁 MST（`T_MST`）和 ETH（`T_ETH < T_MST`），并完成 `verify`。
2. **到期前只读负向检查**（`eth_call`，不花 gas、不改状态）：
   - Bob 提前 refund ETH → `SwapNotExpired`
   - Alice 用错误 secret claim ETH → `InvalidSecret`
   - Bob（sender 而非 recipient）claim ETH → `UnauthorizedReceiver`
   - Bob（recipient 而非 sender）refund MST → `UnauthorizedSender`
   - Alice（sender 而非 recipient）claim MST → `UnauthorizedReceiver`
   - 检查后两边仍为 `Active`
3. 等待/推进到 `T_ETH`，用正确 secret claim ETH → `SwapExpired`；Bob refund ETH → `Refunded`。
4. 等待/推进到 `T_MST`，用正确 secret claim MST → `SwapExpired`；Alice refund MST → `Refunded`。
5. 最终检查：两边 `status=3 Refunded`；Alice 取回锁定的 MST；两个 HTLC 金库各减少锁定额；没有 claim 记录。
6. 余额表分别显示 initial / locked / final；ETH 侧扣除 gas，所以账户原生余额不会精确回到 initial，金库释放额是精确断言。

时间边界与合约一致：`now == timelock` 时 claim 失败、refund 成功（A/B 单测已覆盖 C06/R07；D 脚本在到期后调用 claim 也验证 `SwapExpired`）。

## 7. 本地双链验证与证据

一键运行：

```bash
npm ci --registry=https://registry.npmmirror.com --no-audit --no-fund
npm run compile
npm run local:demo
```

`local-demo`：

- 启动两个独立 Hardhat 节点：Ethereum local `31337`、Arbitrum local `421614`。
- 部署 `MySimpleToken`（官方 Lab 3 MST）、`ERC20HTLC`、`ETHHTLC`。
- 成功场景：`MST_TIMELOCK_SECONDS=300`、`ETH_TIMELOCK_SECONDS=150`、gap=60。
- 退款场景：`MST_TIMELOCK_SECONDS=60`、`ETH_TIMELOCK_SECONDS=30`、gap=10；使用 `evm_increaseTime` 快进，避免真的等 60 秒。
- 生成 `evidence/d-local-two-chain.txt` 和 `evidence/d-local-two-chain.json`；JSON 不含 secret/私钥。

本地结果（`evidence/d-local-two-chain.txt`）：

| 场景 | 结果 |
|---|---|
| 成功流程 | PASS；F01–F05 全部通过；两链 `Claimed` |
| 超时退款流程 | PASS；R01–R05 全部通过；两链 `Refunded` |
| 负向检查 | 5 个预期 revert 全部命中 + 到期后 claim 的 `SwapExpired` |
| 原有单测 | 56 passing（A 37 + B 19，见 `evidence/test-output.txt`） |
| D 回归 | 加入脚本/配置后重跑 `npx hardhat test`：56 passing，exit 0（`evidence/d-regression-tests.txt`） |

真实测试网结果（详见第 8 节）：

| 场景 | 结果 |
|---|---|
| 真实成功 swap | PASS；100 MST ↔ 0.005 ETH；两链 `Claimed` |
| 真实超时退款 | PASS；25 MST / 0.002 ETH；5 个到期前负向检查 + 两笔 `Refunded` |
| 真实部署 | MST、ERC20HTLC、ETHHTLC 均有 explorer 地址和部署 tx hash |

`evidence/d-testnet-readonly.txt` 是部署前/后的只读 RPC 与余额检查；当前 `doctor` 对真实地址应显示 READY。

## 8. 真实测试网部署与运行（已完成）

2026-11-16 使用 Alice/Bob 的真实测试网账户完成。`deployments/testnet.json` 记录了完整部署记录；下列地址可在 explorer 直接打开。

| 链 | 合约 | 地址 | 部署 tx |
|---|---|---|---|
| Ethereum Sepolia | MST (`MySimpleToken`) | `0x64A024DF050eeaEB1f0Dd7d8A9b587E8b6EB3Ef2` | `0x0f8720b48d4769ace39e7367daced00bdaa6a50544ccbc26c791f7394b39ef22` |
| Ethereum Sepolia | `ERC20HTLC` | `0xE1e8D859eA93841081f982f1d65a73640848E701` | `0x003d7c69e838babec7bd426ef55b0df5313efc9263510dab6f0e29752ce3bb49` |
| Arbitrum Sepolia | `ETHHTLC` | `0x3E02C553F3Dac38267f005eEB19cb959be53fF0D` | `0x25a054a26b88e314f358b6470b8a77d20fd13b1965aeb06375afdc51d4a00d96` |

### 真实成功 swap（`demo-success`）

- 参数：100 MST ↔ 0.005 ETH；`T_ETH` 早于 `T_MST` 15 分钟；hashlock 两链一致。
- 结果：F01–F05 全部 PASS，两链 `Claimed`。
- 关键交易：
  - lock MST：`0x8b36a532b746b06daa2ccccd5b45727f304d5d0c4b671bb0ce847c51baba4ae3`
  - lock ETH：`0xb240ec7b387123804d73f5a77cdb1de33fcf2b86559aaa5c8260371e43ed20cf`
  - claim ETH：`0x93bf8eb237609d2e21e54d504af20ffcbd95ea8a815305a53971cfa1e0e19401`
  - claim MST：`0x2ab34ce1bde8cb5479d062e4547593a2bcb12f2237cd38a696121bcf691f2d2d`
- 证据：`evidence/d-testnet-success.txt`；explorer 链接见 README。

### 真实超时退款（`demo-refund`）

- 参数：25 MST / 0.002 ETH；`ETH=90s`、`MST=180s`、gap=30s；等待真实 timelock，没有 fast-forward。
- 到期前负向检查：`SwapNotExpired`、`InvalidSecret`、`UnauthorizedReceiver`、`UnauthorizedSender`、`UnauthorizedReceiver` 全部命中；到期后 claim 命中 `SwapExpired`。
- 结果：R01–R05 全部 PASS，两链 `Refunded`。
- 关键交易：
  - lock MST：`0x96a40bf5df4b6e1d13b019764731d9806946b2afa2745c52f94678c7416ae9ac`
  - lock ETH：`0x99760fa121365ea04f2a0ee788775f0fe300394277047d651741e72b72d2947d`
  - refund ETH：`0x84a4973c2fba6a9c6a8b76d90f111ee834ae74d0c74d23d448ee9e4f6395cacb`
  - refund MST：`0x1288ff3efe4ca8eb8d32a15ff33c7d6845599b3c2d99737838ef7ca0c3a45a22`
- 证据：`evidence/d-testnet-refund.txt`。

### 复现命令

```bash
cp .env.example .env
# 填 RPC、Alice/Bob 私钥
npm run deploy:mst   # 仅当没有现成 MST 地址
npm run doctor
npm run deploy
npm run swap:success -- --label demo-success
npm run swap:refund -- --label demo-refund
```

验收标准均已满足：`doctor` 显示两链 chainId 正确、HTLC/MST 有代码、余额充足；`deployments/testnet.json` 记录地址/tx/block/bytecode hash；成功与退款交易都能在 Sepolia Etherscan / Arbiscan Sepolia 打开。

## 9. 交接给 C / E

给 C：

- 合约 ABI：`abi/ERC20HTLC.abi.json`、`abi/ETHHTLC.abi.json`；`getSwap` 返回 7 个字段，`status` 是 `uint8`，不存在 ID 返回全零。
- 地址：`deployments/testnet.json` 已包含真实地址：MST `0x64A024DF050eeaEB1f0Dd7d8A9b587E8b6EB3Ef2`、ERC20HTLC `0xE1e8D859eA93841081f982f1d65a73640848E701`、ETHHTLC `0x3E02C553F3Dac38267f005eEB19cb959be53fF0D`。
- 状态派生：不要自己发明状态字符串；`Active` + 当前链时间 < timelock = claimable，`Active` + >= timelock = expired/refundable，`Claimed/Refunded` 为终态。
- 事件：`Locked` 取 `swapId`；`Claimed` 取 `secret`；不要读交易返回值。
- 交易反馈：保留通用 revert 处理；自定义错误名和参数顺序见 A 的接口；钱包拒绝、RPC 失败、gas 不足也要显示。
- 前端不需要、也不应该持有私钥；用 MetaMask 当前账户，并让后端脚本只做只读/演示辅助。

给 E：

- 报告/PPT 可直接引用：
  - `evidence/test-output.txt`（56 passing）
  - `evidence/d-local-two-chain.txt` + `.json`（双链成功/退款 2/2 PASS）
  - `evidence/d-testnet-readonly.txt`（真实 RPC/chainId/余额）
  - `evidence/d-testnet-success.txt`、`evidence/d-testnet-refund.txt`、`evidence/d-testnet-runs.json`（真实双链运行）
- 设计图可用“两个独立链 + 共享 hashlock + `T_ETH < T_MST` + 链下协调”的结构；强调没有 bridge/relayer/oracle。
- 限制部分要写：真实测试网已完成成功与退款两条路径；本地/演示用短 timelock；secret 在 claim 后公开；C 前端尚未接入等。

## 10. 安全与限制

- `.env` 被 `.gitignore` 忽略；`.env.example` 只有占位符。脚本不会打印私钥。
- secret 只存 `.runtime/swaps/*.json`（0600）；`.runtime/` 忽略。状态文件里仍有 preimage，演示机应视为敏感文件。
- 成功 claim 后 secret 在链上公开，这是 HTLC 的正常属性；脚本日志默认只显示 fingerprint。
- `refund-flow` 的负向检查使用 `eth_call`，不会产生失败交易；如果演示需要 explorer 上的失败交易，可手工发一笔提前 refund，但会消耗 gas。
- A/B 单测仍使用 `MockMST`（test-only）；本地 `local:demo` 已改用官方 Lab 3 `MySimpleToken`，因此不依赖 `contracts/mocks/`。最终提交包按 A 的说明排除 `mocks/` 时，`local:demo` 仍可用，但必须保留 `contracts/MySimpleToken.sol`。
- `deploy-mst` 部署的是课程 Lab 3 官方教育代币，不是生产稳定币；`MySimpleToken.sol` 按 Lab3 仓库原逻辑复制，仅用于测试网演示。若组里后来拿到官方预部署 MST 地址，直接填 `MST_ADDRESS` 并跳过 `deploy-mst`，`contracts/MySimpleToken.sol` 也可不提交。
- `hardhat.config.js` 的本地网络与 `.env` 中的测试网配置互不污染：本地地址使用 `LOCAL_*`，测试网使用 `MST_ADDRESS` / `ERC20HTLC_ADDRESS` / `ETHHTLC_ADDRESS`。
- `abi/ERC20HTLC.bytecode.txt` 与本地编译只在 metadata hash 上不同；`check-artifacts` 会提示这一点，不影响部署行为。
- 真实测试网交易、真实 MST 余额和 explorer 链接已产生；剩余工作主要是 C 前端接入和 E 报告/PPT 汇总。
- 本次测试网账户的私钥曾通过聊天传输并写入本地 `.env`；演示结束后建议更换账户或把剩余测试币转到新账户，不要复用这些私钥。
- 最终提交 zip 必须排除 `.env` 和 `.runtime/`，只放 `.env.example`；`.runtime/swaps/` 里仍有尚未过期的 preimage。

## 11. 待组内完成

- [x] 真实 Sepolia + Arbitrum Sepolia 部署（MST、ERC20HTLC、ETHHTLC）（D）。
- [x] 真实成功 swap + 超时退款各一次，tx hash 已写入 README/证据（D）。
- [ ] 演示结束后更换测试网账户/私钥，或把剩余测试币转到新账户（D）。
- [ ] C 接入 `deployments/testnet.json` 地址和 ABI，联调 MetaMask 流程（C）。
- [ ] E 汇总报告/PPT/4 分钟演示脚本，引用 D 的本地/测试网证据（E）。
- [ ] A 复核 B 的 `ETHHTLC` 与接口一致性；C/D 发现接口问题先反馈 A（A/B/C/D）。
