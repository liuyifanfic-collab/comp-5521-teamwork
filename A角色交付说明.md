# A 角色交付说明

分工（`7212aa4085ccc4f493b7db866ccb8aed.jpg`）：A = 公共接口/状态设计 + `ERC20HTLC.sol`（MST 锁定、领取、退款、事件、安全检查）；`ETHHTLC.sol` 由 B 实现。

链：Ethereum Sepolia｜资产：MST（ERC20，18 decimals）｜无构造函数、无参部署｜solc 0.8.28 / OpenZeppelin v5。

## 接口冻结声明

**状态：已冻结 `Frozen v1.0`（2026-11-10）。** A 为前置角色，B/C/D 依赖本接口开展工作，故由 A 直接确定并冻结，无需等待组内确认；B/C/D 以本节、`contracts/IERC20HTLC.sol` 与 `abi/ERC20HTLC.abi.json` 为唯一基准。

| 冻结项 | 基准 |
|---|---|
| 函数签名、`getSwap` 返回顺序 | `IERC20HTLC.sol`；下文「函数」 |
| 事件名 / 参数顺序 / indexed | 同上；下文「事件」 |
| 错误名 / 参数 / 校验顺序 | 同上；下文「错误」「校验序」 |
| status 取值、时间边界、终态规则 | 下文「状态与不变量」 |
| hashlock、swapId 公式 | 同上 |

变更规则：如需修改上述任一项，由 A 统一发布新版本，并同步合约、ABI/bytecode、单测与本文；其他同学不得单方面改动。

## 产物

| 文件 | 用途 |
|---|---|
| `contracts/ERC20HTLC.sol` | 实现；合入组内 Hardhat 项目 |
| `contracts/IERC20HTLC.sol` | 公共接口（事件/错误/状态/签名）；B 对齐基准 |
| `abi/ERC20HTLC.abi.json` | ABI → C/D |
| `abi/ERC20HTLC.bytecode.txt` | creation bytecode → D 部署 |
| `test/ERC20HTLC.test.js` | 单测：矩阵 P0 全覆盖 + L14/C09/R09 |
| `evidence/test-output.txt` | 运行输出（37 passing，退出码 0） |
| `contracts/mocks/` | MockMST、恶意代币；仅本地单测，勿进最终 `contracts/` |
| `hardhat.config.js`、`package.json` | 本地编译测试；无双链网络/RPC/私钥/部署脚本 |

## 状态与不变量

| 项 | 约定 |
|---|---|
| status | `0 None / 1 Active / 2 Claimed / 3 Refunded`，终态不可逆 |
| 流转 | `None --lock--> Active`；`Active --claim--> Claimed`；`Active --refund--> Refunded` |
| 时间 | claim `now < timelock`；refund `now >= timelock`；`now == timelock` 只能 refund（C06/R07 已测） |
| hashlock | `keccak256(abi.encodePacked(secret))`，secret 为 `bytes32` |
| swapId | `keccak256(abi.encode(block.chainid, address(this), msg.sender, nonce))`，nonce 递增；两链 swapId 独立，靠 hashlock 关联 |
| ETH | `receive/fallback` → `revert UnexpectedEther()`；直接转入的 MST 不形成 swap |
| 安全 | CEI + SafeERC20 + nonReentrant；claim 只给 recipient，refund 只给 sender；单笔最多释放一次 |

## 函数

| 函数 | 条件 | 效果 |
|---|---|---|
| `lock(token, recipient, amount, hashlock, timelock) → swapId` | 先 `MST.approve(HTLC, amount)`；校验序：token≠0 → recipient≠0 → amount>0 → hashlock≠0 → timelock>now | `safeTransferFrom` 锁入；写 Active；发 `Locked` |
| `claim(swapId, secret)` | 仅 recipient + Active + 未过期 + 哈希匹配 | 先置 Claimed → 转 MST → 发 `Claimed(swapId, secret)`（公开 secret） |
| `refund(swapId)` | 仅 sender + Active + 已过期 | 先置 Refunded → 退 MST → 发 `Refunded` |
| `getSwap(swapId)` | view | 返回 `(sender, recipient, token, amount, hashlock, timelock, uint8 status)`，顺序固定；不存在返回全零且不 revert |

事件（完整定义见 `IERC20HTLC.sol`）：

```solidity
event Locked(bytes32 indexed swapId, address indexed sender, address indexed recipient,
             address token, uint256 amount, bytes32 hashlock, uint256 timelock);
event Claimed(bytes32 indexed swapId, bytes32 secret);
event Refunded(bytes32 indexed swapId);
```

错误：`InvalidAddress` `InvalidToken` `InvalidAmount` `InvalidHashlock` `InvalidTimelock` `UnexpectedEther` `SwapAlreadyExists(swapId)` `SwapNotFound(swapId)` `SwapNotActive(swapId)` `UnauthorizedReceiver(swapId,caller)` `UnauthorizedSender(swapId,caller)` `SwapExpired(swapId)` `SwapNotExpired(swapId)` `InvalidSecret(swapId)`

校验序（错误预期）：`claim` NotFound → NotActive → UnauthorizedReceiver → Expired → InvalidSecret；`refund` NotFound → NotActive → UnauthorizedSender → NotExpired。

## 接入要点

| 角色 | 要点 |
|---|---|
| B | 以冻结接口为准：ETHHTLC 复用同一套状态/事件/错误/`getSwap` 顺序/时间边界；差异：`lock(recipient,hashlock,timelock)` payable、`amount=msg.value`、`token=address(0)`、零值拒绝、ETH 用 `call` + 先置终态 + 防重入；ETH 转账失败错误需自定义 |
| C | 用 `abi/ERC20HTLC.abi.json`；`status` 是 `uint8` 非字符串；不存在 ID 返回全零；`Claimable/Expired/Refundable` 不上链，由 status+now 派生；合约会拒绝越权/过期/重复操作，勿只隐藏按钮 |
| D | 部署无参；`swapId` 从 `Locked` 事件取（勿读交易返回值）；`secret` 从 `Claimed` 事件取；lock 前先 approve；建第二把锁前核对参数且保证 ETH 锁 `T2 < MST 锁 T1`；两链分别存 swapId；超时各自 refund |
| E | 产物与证据见上表；接口已冻结 `Frozen v1.0`；产物未合入组内仓库、B 的 ETHHTLC 审查待其提交 |

## 复现

```
npm install
npx hardhat compile   # Compiled 16 Solidity files successfully (evm target: paris)
npx hardhat test      # 37 passing
```

## 待组内完成

- 将冻结接口与产物合入组内 Hardhat 项目，向 C/D 交付 ABI/bytecode；D 部署后联调
- B 按冻结接口实现 `ETHHTLC.sol`；提交后由 A 完成代码审查并留证据
