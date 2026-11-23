# C 角色交付说明

分工：C = 前端领取与退款页面（MetaMask、网络切换、余额、approve、锁定、领取、退款、交易反馈），对应课程评分 Task C（C1–C4），并为 Task B 的"双链状态观察"和"超时退款"提供界面。

技术栈：Vite + 原生 JavaScript + ethers v6，不依赖 React 等框架。ABI 直接引用仓库根目录 `abi/` 下 A/B 的交付件，不复制、不修改合约与 ABI，遵守"禁止跨模块私改"。

## 当前状态

| 项 | 状态 |
|---|---|
| 页面功能（C1–C4） | ✅ 完成 |
| 本地双链 Mock 联调 | ✅ 完成：成功交换、双边超时退款、5 种合约应拒绝的无效操作，手动测试全部通过（见「测试」） |
| 接入测试网真实合约 | ✅ 完成：2026-11-23 用 MetaMask 在 Sepolia / Arbitrum Sepolia 上跑通成功交换与双边超时退款（见「测试」） |
| 代码提交 | ✅ 已通过 PR #2 合并到 `main` |

## 产物

| 路径 | 用途 |
|---|---|
| `frontend/index.html`、`frontend/src/style.css` | 页面结构与毛玻璃样式 |
| `frontend/src/main.js` | 页面逻辑：引导式流程、双链状态卡片、交易记录、余额与进度条 |
| `frontend/src/protocol.js` | secret / hashlock 生成、读取 swap、由 status + 链上时间派生状态、参数核验、读取 Claimed 事件中的 secret |
| `frontend/src/wallet.js` | 钱包连接、网络切换（钱包没有该网络时自动添加） |
| `frontend/src/contracts.js` | ABI 与两条链各自独立的只读 RPC |
| `frontend/src/errors.js` | 解码合约自定义错误、OpenZeppelin 错误、钱包拒签等 |
| `frontend/src/config.js`、`frontend/.env.example` | 网络与合约地址配置（只含公开信息，无私钥） |
| `frontend/src/i18n.js` | 中英双语文案 |
| `frontend/src/reactbits/` | 背景与动效组件（来源见「UI 来源与 AI 使用」） |
| `frontend/src/devWallet.js`、`frontend/dev/` | 仅本地开发用：两条本地 Hardhat 链的配置、Mock 部署脚本、免 MetaMask 的测试钱包 |
| `frontend/TEST-CASES.md` | 本地测试用例（步骤 + 预期结果 + 结果记录表） |
| `frontend/README.md` | 运行说明 |

`frontend/dev/` 与 `devWallet.js` 只用于本地 Mock 联调：`devWallet.js` 仅在 URL 带 `?devwallet` 且为本地配置时启用，借用 Hardhat 节点自带的已解锁测试账户，不包含、不读取任何私钥；测试网配置下不会启用。

## 运行

本地双链 Mock（无需 MetaMask 和测试币），完整步骤见 `frontend/TEST-CASES.md` 第 0 节：

1. 启动两条本地 Hardhat 链：chainId 31337（端口 8545）模拟 Ethereum Sepolia，chainId 31338（端口 8546）模拟 Arbitrum Sepolia。
2. `node frontend/dev/deploy-local.cjs`：在链 A 部署 MockMST + ERC20HTLC，在链 B 部署 ETHHTLC，自动生成 `frontend/src/config.local.json`（已加入 `.gitignore`）。
3. `cd frontend && npm install && npm run dev`，打开 `http://localhost:5173/?devwallet`。

测试网：复制 `frontend/.env.example` 为 `frontend/.env.local`，填入 D 提供的地址，`VITE_PROFILE=testnet`，用 MetaMask 连接。

## 功能与评分项对应

| 评分项 | 实现 |
|---|---|
| C1 钱包与网络 | 连接钱包；顶栏显示账户与所在网络（绿点：项目网络，黄点：其他网络）；一键切换 Ethereum Sepolia / Arbitrum Sepolia |
| C2 状态展示与授权 | 余额卡片（MST、两条链上的 ETH、MST 授权额度）；合约地址；swap 全部字段（sender、recipient、金额、hashlock、timelock 与倒计时、链上时间）；MST approve |
| C3 引导流程 | Alice：生成 secret → approve / 锁定 MST → 核验 Bob 的 ETH 锁（7 项）→ 领取 ETH；Bob：核验 Alice 的 MST 锁（6 项）→ 锁定 ETH（页面强制 T2 < T1）→ 自动从 Claimed 事件取得 secret 并校验 → 领取 MST；过期后显示退款。"当前步骤"高亮，不满足条件的按钮禁用并写明原因 |
| C4 反馈 | 交易记录（等待签名 / 已广播 / 已确认 / 失败）、区块浏览器链接、合约错误中文 / 英文解码、完成 / 退款横幅、五步协议进度条 |
| 支持 B3 / B4 | 两条链用各自独立的只读 RPC 读取，不假设合约互相通信；"可领取 / 已过期可退款"由链上 status + 该链最新区块时间 + 当前账户派生；终态不再提供操作 |

其他：中英双语切换；角色标签与钱包账户双向同步（本地测试账户）；手机宽度单列布局；"仍然尝试领取 / 退款"链接会真实调用合约，用于现场演示合约拒绝无效操作。

## 与 A/B 接口的对接要点

按 A 的 Frozen v1.0 与 B 的说明实现：

- `status` 按 `uint8` 处理（0 None / 1 Active / 2 Claimed / 3 Refunded）；不存在的 swapId 返回全零，按 `status == 0` 判断。
- swapId 从交易回执的 `Locked` 事件解析，不读函数返回值；secret 从 `Claimed` 事件读取，并校验 `keccak256(secret) == hashlock`。
- 时间边界与合约一致：领取要求 `now < timelock`，退款要求 `now >= timelock`；`now` 使用该链最新区块时间，而不是本机时钟。
- ERC20HTLC 的 `lock(token, recipient, amount, hashlock, timelock)` 前先检查授权额度；ETHHTLC 的 `lock(recipient, hashlock, timelock)` 用 `value` 传金额。
- 错误处理覆盖接口声明的错误、`ETHTransferFailed`、OpenZeppelin 的 `ReentrancyGuardReentrantCall` / `SafeERC20FailedOperation` / ERC20 授权与余额错误，并保留通用 revert 与钱包错误的兜底。
- 页面禁用按钮只是提示，真正的拒绝由合约完成（可用"仍然尝试"链接验证）。

## UI 来源与 AI 使用

### 我负责的工作

- **协议层编写**：前端的 HTLC 协议层（授权、锁定、双方核验、领取 / 退款、secret 传递、状态判断、交易执行与反馈，共 11 个函数）由我自己编写，见下方「AI 的使用」。
- **需求与交互设计**：确定页面要覆盖的流程和信息：Alice / Bob 两个角色的引导步骤、两条链各自独立读取的状态卡片、交易记录与错误反馈；对照评分项 C1–C4 逐项确认。
- **视觉方向**：沿用我之前的项目 DevPath 的毛玻璃设计规范，包括半透明卡片、背景模糊、边框、圆角、胶囊按钮、白底选中的切换开关以及配色。
- **组件选型**：在 React Bits（reactbits.dev）中挑选适合本项目的组件，决定每个组件放在哪里、解决什么问题（见下表）；背景选定 Dark Veil 的 Storm 预设。
- **审查与迭代**：每一轮都在浏览器里实际运行并检查，发现问题后提出修改。由我发现并推动修复的问题包括：宽屏下右栏出现大块空白、顶栏与内容区宽度不一致、灰色文字对比度不足、顶栏控件分组不合理、背景光幕分布不均、背景导致 GPU 占用过高、顶部切换账户时角色标签不同步。
- **测试**：按 `frontend/TEST-CASES.md` 手动执行全部用例，确认结果（见「测试」）。

### AI 的使用

**前端的 HTLC 协议层由我编写**：Alice 与 Bob 两侧从授权、锁定、核验、领取 / 退款到 secret 传递的完整流程，以及所有交易共用的执行与反馈。按交换流程：

| 流程环节 | 我编写的函数 | 内容 |
|---|---|---|
| 授权 | `actions.approve`（`main.js`） | Alice 授权 ERC20HTLC 合约（而非 Bob）转走本次要锁定的 MST，只授权本次金额 |
| 锁定资产 | `actions.lockMst`（`main.js`） | Alice 按 MST 链时间计算 T1，锁定 MST，从 `Locked` 事件解析 swapId |
| | `actions.lockEth`（`main.js`） | Bob 从 Alice 的锁读取收款人与 hashlock，保证两边 hashlock 一致；跨链时间约束 T2 + 安全间隔 ≤ T1 只能由链下保证，在发交易前强制检查 |
| 锁定前 / 领取前核验 | `verifyMstLock`（`protocol.js`） | Bob 锁 ETH 前核验 Alice 的锁（6 项：状态、收款人、代币、金额、hashlock 非零、T1 剩余时间足够再创建一笔更早到期的锁） |
| | `verifyEthLock`（`protocol.js`） | Alice 领取前核验 Bob 的锁（7 项：状态、收款人、资产、hashlock 一致、金额、T2 < T1、剩余时间），避免领取失败时 secret 被白白公开 |
| secret 传递 | `findRevealedSecret`（`protocol.js`） | 从 ETH 链 `Claimed` 事件读取 Alice 公开的 secret |
| | `actions.fetchSecret`（`main.js`） | Bob 读取 secret 后，校验 `keccak256(secret)` 与 MST 锁的 hashlock 一致才允许领取 |
| 领取与退款 | `actions.claim` / `actions.refund`（`main.js`） | 按链发起领取 / 退款；secret 只做格式检查，正确性交给合约判断（可演示合约返回 `InvalidSecret`） |
| 状态与时间判断 | `deriveState`（`protocol.js`） | 由链上 status、该链区块时间和当前账户派生"可领取 / 已过期可退款"，边界与合约一致（`now < timelock` 可领取，`now >= timelock` 可退款）；未知状态一律不允许操作。页面上所有领取 / 退款按钮都依赖它 |
| 交易执行与反馈（C4） | `runTx`（`main.js`） | 所有交易共用的执行流程：等待签名 → 已广播 → 已确认 / 失败，错误解码、防重复提交、完成后重新读链 |


**AI 编写的部分**，以及我在这些部分上的工作：

| 模块 | AI 完成的部分 | 我的工作 |
|---|---|---|
| 页面结构与渲染（`index.html`、`main.js` 中上表以外的部分：页面渲染、会话保存、事件绑定，以及调用核验函数的 `verifyMst` / `verifyEth`、`generateSecret` 等） | 编写代码 | 确定 Alice / Bob 引导步骤、双链状态卡片、交易记录等页面内容与布局；运行审查，发现并要求修复右栏空白、顶栏分组、角色标签不同步等问题 |
| 读链辅助与通用模块（`protocol.js` 中的 `readSwap`、`swapIdFromReceipt`、`newSecret`、`hashlockOf`，以及 `contracts.js`、`wallet.js`、`errors.js`、`config.js`） | 编写代码 | 提出需要覆盖的流程与核验项；通过测试用例验证成功交换、超时退款和 5 种无效操作的行为 |
| 样式（`style.css`） | 按 DevPath 的样式移植并适配 | 提供 DevPath 项目作为设计规范，对照实际效果逐项要求调整（卡片色带、切换开关样式、文字对比度、顶栏宽度） |
| React Bits 组件（`reactbits/`） | 从 React 重写为原生 JavaScript | 挑选组件并决定用途与位置；选定 Dark Veil 的 Storm 预设；发现背景分布不均和 GPU 占用过高并要求优化 |
| 中英双语（`i18n.js`） | 编写代码与译文 | 提出双语需求，检查切换效果 |
| 本地测试工具与用例（`dev/`、`devWallet.js`、`TEST-CASES.md`） | 编写脚本与用例文档 | 按用例手动执行全部测试并记录结果 |

React Bits 组件对应的用途：

| 组件 | 用途 |
|---|---|
| Dark Veil | 页面背景（Storm 预设，另加 `rotation: 180` 使光幕更均匀；降低渲染分辨率并限制 30fps，降低 GPU 占用） |
| Decrypted Text | secret / hashlock 出现时的解密动画 |
| Count Up | 余额变化时的数字滚动 |
| Status Mark | 交易记录与进度条的状态图标 |
| Border Glow | 步骤卡片的发光边框，"当前步骤"切换时扫光 |
| Shiny Text | 完成 / 退款横幅的扫光文字 |
| Hold Button | 长按 1.2 秒确认退款，防止误触 |

每个组件文件开头注明了来源、许可证（MIT + Commons Clause）和相对原版的改动。

## 测试

- 测试用例：`frontend/TEST-CASES.md`，包含 3 个用例：
  - 用例 1，成功交换：16 步，穿插 4 种无效操作。
  - 用例 2，双边超时退款：12 步，含"过期后领取"。
  - 用例 3，界面检查：语言切换、网络切换、刷新恢复、手机宽度等。
- 2026-11-16，我在本地双链 Mock 上手动执行了全部用例，**全部通过**。
- 覆盖的无效操作及合约返回：到期前退款（`SwapNotExpired`）、非收款人领取（`UnauthorizedReceiver`）、T2 不早于 T1（页面拦截，不发交易）、错误 secret（`InvalidSecret`）、过期后领取（`SwapExpired`）。另含核验金额不符时禁止锁定 ETH、长按按钮轻点不触发。
- 测试之后的界面调整（默认背景改为 Dark Veil、角色标签与账户同步）已在浏览器中重新验证，不涉及协议逻辑。
- 重写后的协议层已在本地双链上验证：一轮完整成功交换（含 Bob 核验金额不符被拦截）、T2 晚于 T1 被拦截、未授权锁定、格式错误 / 内容错误的 secret、过期后长按退款，结果均符合预期；完整的 `TEST-CASES.md` 用例建议在演示前再按文档执行一遍并更新日期。
- **测试网联调（2026-11-23）**：使用 D 部署的合约（地址见 `deployments/testnet.json`），两个 MetaMask 测试账户在同一浏览器中分别扮演 Alice / Bob，全部通过前端操作完成，实际签名、公共 RPC 读状态与 Claimed 事件查询均正常。链上记录如下：

  | 流程 | 链 | swapId | 结果 | 交易 |
  |---|---|---|---|---|
  | 成功交换 | Sepolia（MST 200） | `0x797bb61de9386b202ca8eecf5c6199d907a2c3e50a9de446936c68e4e2304cd8` | Claimed（Bob 领取 MST） | 锁定 `0x649daeaa…d379`，领取 `0x76044907…2541` |
  | 成功交换 | Arbitrum Sepolia（ETH 0.01） | `0x44a0cb370dff091efd3596bbbf6ccc127c6b4fb171dcc66f5c4eb5e21f260d7f` | Claimed（Alice 领取 ETH，公开 secret） | 锁定 `0xda255fac…a0a`，领取 `0x58b7e839…49f1` |
  | 超时退款 | Sepolia（MST 50，T1 8 分钟） | `0xcfdc4c60c5d6005a594d73146bc5c99b243066336adc1fd8f4cdf4da1d4a9e63` | Refunded（Alice 退回 MST） | 锁定 `0x3d60fe19…93f7`，退款 `0xb0393421…5711` |
  | 超时退款 | Arbitrum Sepolia（ETH 0.005，T2 3 分钟） | `0x83ec605f46e35a7697656ea20d268ddfd959e1082f4ea4c64b1d1c596ccfcd9b` | Refunded（Bob 退回 ETH） | 锁定 `0x3b12a425…c5d4`，退款 `0x7f4f2304…720f` |

  每组两条链上的 hashlock 一致；成功交换中 T2（14:49:19 UTC）早于 T1（15:03:48 UTC），退款中 T2（14:44:45）早于 T1（14:48:48），Bob 先于 Alice 退款。
- 测试网上遇到的问题：Arbitrum Sepolia 上 MetaMask 偶尔把 max fee 估得略低于区块 base fee，交易被节点拒绝（未上链、未扣费），重试即可；Alice 领取 ETH 时出现过一次，重试后成功。

## 已知限制

- secret 保存在浏览器 localStorage，用于刷新后恢复，演示用途；清除浏览器数据后，未完成交换的 secret 会丢失。
- 同一浏览器内 Alice / Bob 共用一份本地会话（方便单机演示）；真实场景下双方需通过链下渠道交换 swapId。
- 公共 RPC 对日志查询的区块范围有限制：测试网配置需要填写部署区块（`VITE_*_DEPLOY_BLOCK`），以缩小 Claimed 事件的查询范围。
- 背景为 WebGL 动画（单层、30fps，M1 Pro 实测 GPU 约 4%）；浏览器不支持 WebGL2 时自动退回 CSS 渐变。

## 待组内完成 / 交接

| 角色 | 事项 |
|---|---|
| D | ✅ 已提供 ERC20HTLC（Sepolia）、MST（Sepolia）、ETHHTLC（Arbitrum Sepolia）地址与部署区块（`deployments/testnet.json`），并向 C 的测试账户转入 MST |
| C | ✅ 已填入 `frontend/.env.local` 并用 MetaMask 在测试网跑通成功与退款流程；✅ 前端已合并到 `main` |
