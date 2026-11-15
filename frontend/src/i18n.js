// 中英双语：t(key, vars) 取当前语言文案；lazy(key, vars) 返回一个在渲染时才翻译的对象，
// 用于存进状态里的文案（交易记录、核验清单、错误），切换语言后重新渲染即可更新。

const zh = {
  "doc.title": "HTLC 跨链交换",
  "brand.title": "跨链交换",
  "profile.local": "本地双链 Mock",
  "profile.testnet": "Testnet",
  "lang.aria": "切换语言",
  "net.aria": "切换网络",
  "net.mst": "MST 链",
  "net.eth": "ETH 链",
  "net.switchTo": "切换到 {name}",
  "dev.accountTitle": "本地 dev wallet 账户",
  "dev.testAccount": "测试账户",
  "pill.disconnected": "未连接",
  "btn.connect": "连接钱包",
  "btn.connected": "已连接",
  "chain.unknown": "未知网络 (chainId {id})",
  "chain.31337": "本地链 A（模拟 Ethereum Sepolia）",
  "chain.31338": "本地链 B（模拟 Arbitrum Sepolia）",

  "card.account": "账户与进度",
  "tl.secret": "生成 secret",
  "tl.lockMst": "锁定 MST",
  "tl.lockEth": "锁定 ETH",
  "tl.claimEth": "领取 ETH",
  "tl.claimEthSub": "公开 secret",
  "tl.claimMst": "领取 MST",
  "tl.claimMstSub": "用公开的 secret",
  "tl.refunded": "已退款",
  "card.workflow": "交换流程",
  "card.monitor": "双链状态（各自独立读取）",
  "card.log": "交易记录",
  "role.alice": "Alice · 发起方（MST → ETH）",
  "role.bob": "Bob · 响应方（ETH → MST）",
  "btn.reset": "开始新的交换（清空本地会话）",
  "confirm.reset": "清空本地保存的 secret 和 swapId？链上资产不受影响，但未完成交换的 secret 会丢失。",
  "prompt.secret": "输入 secret（0x 开头 32 字节）",

  "acct.missing": "合约地址未配置：请在 frontend/.env.local 中填写（见 .env.example）",
  "acct.account": "账户",
  "acct.mstBalance": "MST 余额",
  "acct.allowance": "MST 已授权",
  "acct.ethOnMst": "ETH · MST 链",
  "acct.ethOnEth": "ETH · ETH 链",
  "acct.gas": "付 gas",
  "acct.mstToken": "MST 代币",

  "refresh.at": "更新于 {time}",
  "refresh.fail": "读取失败：{err}",
  "time.expiredFor": "已过期 {d}",
  "time.remaining": "剩余 {d}",
  "time.ms": "{m}分{s}秒",
  "time.s": "{s}秒",

  "tx.waitSign": "等待钱包签名…",
  "tx.broadcast": "已广播，等待确认…",
  "tx.confirmed": "已确认（区块 {block}）",
  "tx.failed": "失败",
  "tx.failedToast": "{label} 失败：{err}",
  "tx.none": "还没有交易",
  "tx.noExplorer": "(本地链无浏览器)",
  "tx.approve": "approve {amount}",
  "tx.lockMst": "锁定 {amount}（T1 = {time}）",
  "tx.lockEth": "锁定 {amount}（T2 = {time}）",
  "tx.claim": "在 {chain} 领取",
  "tx.refund": "在 {chain} 退款",

  "toast.t2Order": "T2 必须比 T1 至少早 {gap}s：T2={t2}，T1={t1}",
  "toast.noClaimYet": "ETH 链上还没有 Claimed 事件，Alice 尚未领取",
  "toast.secretMismatch": "取到的 secret 与 MST 锁的 hashlock 不匹配！",
  "toast.badSecret": "secret 必须是 0x 开头的 32 字节十六进制",

  "step.done": "完成",
  "step.current": "当前步骤",
  "step.pending": "待进行",

  "a1.title": "1. 生成 secret 与 hashlock",
  "a1.desc": "secret 只保存在本浏览器；hashlock = keccak256(secret) 将公开在两条链上。",
  "a1.btn": "生成新的 secret",
  "a1.none": "尚未生成",
  "a2.title": "2. 在 {chain} 授权并锁定 MST",
  "a2.bob": "Bob 地址（收款人）",
  "a2.amount": "MST 数量",
  "a2.t1": "T1：多少分钟后到期",
  "a2.approve": "① approve",
  "a2.lock": "② 锁定 MST",
  "a2.hint.connect": "请先连接钱包",
  "a2.hint.secret": "请先生成 secret",
  "a2.hint.locked": "已锁定，见右侧 MST swap",
  "a2.hint.badBob": "Bob 地址无效",
  "a2.hint.zero": "数量必须大于 0",
  "a2.hint.balance": "MST 余额不足（{balance}）",
  "a2.hint.allowance": "授权额度 {allowance} 不足，请先 approve",
  "a2.hint.ready": "授权额度 {allowance}，可以锁定",
  "a3.title": "3. 核验 Bob 在 {chain} 的 ETH 锁",
  "a3.desc": "向 Bob 发送 MST swapId（见右侧）。拿到 Bob 的 ETH swapId 后核验参数。",
  "a3.expect": "约定 ETH 数量（可选）",
  "a3.placeholder": "例如 0.01",
  "verify.btn": "读取并核验",
  "a4.title": "4. 用 secret 领取 ETH（公开 secret）",
  "a4.desc": "领取后 secret 会出现在 {chain} 的 Claimed 事件中，Bob 可用它领取 MST。",
  "a4.btn": "领取 ETH",
  "a4.hint.claimed": "已领取，secret 已公开",
  "a4.hint.verify": "请先核验 ETH 锁",

  "b1.title": "1. 核验 Alice 在 {chain} 的 MST 锁",
  "b1.id": "MST swapId（Alice 提供）",
  "b1.expect": "约定 MST 数量（可选）",
  "b1.placeholder": "例如 10",
  "b2.title": "2. 在 {chain} 锁定 ETH（T2 &lt; T1）",
  "b2.desc": "收款人与 hashlock 直接取自已核验的 MST 锁，不需要手填。",
  "b2.amount": "ETH 数量",
  "b2.t2": "T2：多少分钟后到期",
  "b2.btn": "锁定 ETH",
  "b2.hint.t2": "T1 = {t1}；按当前输入 T2 ≈ {t2} {verdict}",
  "b2.hint.ok": "✔ 满足 T2 < T1",
  "b2.hint.bad": "✘ 需比 T1 至少早 {gap}s",
  "b2.hint.locked": "已锁定，见右侧 ETH swap",
  "b2.hint.verify": "请先核验 MST 锁",
  "b3.title": "3. 等待 Alice 领取，从 {chain} 读取 secret",
  "b3.desc": "页面会自动监听；也可以手动读取 Claimed 事件。",
  "b3.btn": "读取 secret",
  "b3.got": "已取得 secret（keccak256 校验通过）",
  "b3.none": "尚未公开",
  "b4.title": "4. 用 secret 在 {chain} 领取 MST",
  "b4.btn": "领取 MST",
  "b4.hint.claimed": "已领取，交换完成",
  "b4.hint.wait": "等待 secret 公开",

  "card.mstLock": "MST 锁 · {chain}",
  "card.ethLock": "ETH 锁 · {chain}",
  "card.notCreated": "未创建",
  "card.noId": "还没有 swapId",
  "card.loading": "读取中…",
  "card.status": "链上状态",
  "card.amount": "金额",
  "card.chainTime": "链上时间",
  "card.me": " (我)",
  "card.claim": "领取",
  "card.refund": "退款",
  "card.claimReason": "领取：{r}",
  "card.refundReason": "退款：{r}",
  "card.sep": "；",
  "card.forceClaim": "仍然尝试领取",
  "card.forceRefund": "仍然尝试退款",
  "hold.refund": "长按退款",
  "hold.done": "已提交",
  "hold.hint": "按住 1.2 秒确认退款",
  "card.forceNote": "（演示：合约会拒绝无效操作）",
  "banner.done": "✔ 交换完成：两条链上的锁均已领取",
  "banner.refunded": "↩ 交换未完成，已退款：{parts}",
  "banner.mstBack": "MST 已退回 Alice",
  "banner.ethBack": "ETH 已退回 Bob",
  "banner.join": "，",

  "state.none": "不存在",
  "state.claimed": "已领取 Claimed",
  "state.refunded": "已退款 Refunded",
  "state.expired": "已过期 · 可退款 Refundable",
  "state.active": "锁定中 · 可领取 Claimable",
  "reason.expired": "已过期，不能领取",
  "reason.notRecipient": "当前账户不是收款人",
  "reason.notExpired": "尚未到期，不能退款",
  "reason.notSender": "当前账户不是发送方",

  "check.active": "swap 存在且为 Active（当前 {status}）",
  "check.recipientMe": "收款人是当前账户",
  "check.tokenMst": "锁定的代币是配置中的 MST",
  "check.amount": "锁定金额 ≥ 约定金额",
  "check.hashlockNonzero": "hashlock 非零",
  "check.t1Room": "T1 剩余 {remaining}s，足够再创建一个更早到期的 ETH 锁（需 > {need}s）",
  "check.nativeEth": "资产为原生 ETH（token = 0x0）",
  "check.hashlockMatch": "hashlock 与 MST 锁一致",
  "check.t2BeforeT1": "T2 < T1（T2 至少早 {gap}s 到期）",
  "check.t2Room": "T2 剩余 {remaining}s，来得及领取",

  "err.noWallet": "未检测到钱包，请安装 MetaMask（或本地开发时在 URL 加 ?devwallet）",
  "err.rejected": "已在钱包中取消",
  "err.contract": "合约拒绝",
  "err.InvalidAddress": "地址无效（收款人为零地址）",
  "err.InvalidToken": "代币地址无效",
  "err.InvalidAmount": "金额必须大于 0",
  "err.InvalidHashlock": "hashlock 不能为 0",
  "err.InvalidTimelock": "到期时间必须晚于当前链上时间",
  "err.UnexpectedEther": "合约不接受直接转入的 ETH",
  "err.SwapAlreadyExists": "swap 已存在",
  "err.SwapNotFound": "swap 不存在（swapId 错误或在另一条链上）",
  "err.SwapNotActive": "swap 已结束（已领取或已退款），不能重复操作",
  "err.UnauthorizedReceiver": "只有指定收款人才能领取",
  "err.UnauthorizedSender": "只有原发送方才能退款",
  "err.SwapExpired": "已过期，不能再领取（只能由发送方退款）",
  "err.SwapNotExpired": "尚未到期，不能退款",
  "err.InvalidSecret": "secret 不正确：keccak256(secret) ≠ hashlock",
  "err.ETHTransferFailed": "ETH 转账失败，状态已回滚",
  "err.ReentrancyGuardReentrantCall": "重入调用被拦截",
  "err.SafeERC20FailedOperation": "代币转账失败",
  "err.ERC20InsufficientAllowance": "MST 授权额度不足，请先 approve",
  "err.ERC20InsufficientBalance": "MST 余额不足",
  "err.named": "{name}：{msg}",
};

const en = {
  "doc.title": "HTLC Cross-Chain Swap",
  "brand.title": "Cross-Chain Swap",
  "profile.local": "Local dual-chain mock",
  "profile.testnet": "Testnet",
  "lang.aria": "Switch language",
  "net.aria": "Switch network",
  "net.mst": "MST chain",
  "net.eth": "ETH chain",
  "net.switchTo": "Switch to {name}",
  "dev.accountTitle": "Local dev wallet account",
  "dev.testAccount": "Test account",
  "pill.disconnected": "Not connected",
  "btn.connect": "Connect wallet",
  "btn.connected": "Connected",
  "chain.unknown": "Unknown network (chainId {id})",
  "chain.31337": "Local Chain A (Ethereum Sepolia mock)",
  "chain.31338": "Local Chain B (Arbitrum Sepolia mock)",

  "card.account": "Account & progress",
  "tl.secret": "Generate secret",
  "tl.lockMst": "Lock MST",
  "tl.lockEth": "Lock ETH",
  "tl.claimEth": "Claim ETH",
  "tl.claimEthSub": "reveals the secret",
  "tl.claimMst": "Claim MST",
  "tl.claimMstSub": "with the revealed secret",
  "tl.refunded": "Refunded",
  "card.workflow": "Swap workflow",
  "card.monitor": "Both chains (read independently)",
  "card.log": "Transactions",
  "role.alice": "Alice · Initiator (MST → ETH)",
  "role.bob": "Bob · Responder (ETH → MST)",
  "btn.reset": "Start a new swap (clear local session)",
  "confirm.reset": "Clear the locally saved secret and swap IDs? On-chain assets are not affected, but the secret of an unfinished swap will be lost.",
  "prompt.secret": "Enter the secret (32 bytes, 0x-prefixed)",

  "acct.missing": "Contract addresses not configured: fill them in frontend/.env.local (see .env.example)",
  "acct.account": "Account",
  "acct.mstBalance": "MST balance",
  "acct.allowance": "MST allowance",
  "acct.ethOnMst": "ETH · MST chain",
  "acct.ethOnEth": "ETH · ETH chain",
  "acct.gas": "for gas",
  "acct.mstToken": "MST token",

  "refresh.at": "Updated {time}",
  "refresh.fail": "Read failed: {err}",
  "time.expiredFor": "Expired {d} ago",
  "time.remaining": "{d} left",
  "time.ms": "{m}m {s}s",
  "time.s": "{s}s",

  "tx.waitSign": "Waiting for wallet signature…",
  "tx.broadcast": "Broadcast, waiting for confirmation…",
  "tx.confirmed": "Confirmed (block {block})",
  "tx.failed": "Failed",
  "tx.failedToast": "{label} failed: {err}",
  "tx.none": "No transactions yet",
  "tx.noExplorer": "(no explorer on local chain)",
  "tx.approve": "approve {amount}",
  "tx.lockMst": "Lock {amount} (T1 = {time})",
  "tx.lockEth": "Lock {amount} (T2 = {time})",
  "tx.claim": "Claim on {chain}",
  "tx.refund": "Refund on {chain}",

  "toast.t2Order": "T2 must be at least {gap}s earlier than T1: T2={t2}, T1={t1}",
  "toast.noClaimYet": "No Claimed event on the ETH chain yet — Alice has not claimed",
  "toast.secretMismatch": "The revealed secret does not match the MST lock's hashlock!",
  "toast.badSecret": "The secret must be 32 bytes of 0x-prefixed hex",

  "step.done": "Done",
  "step.current": "Current step",
  "step.pending": "Pending",

  "a1.title": "1. Generate secret and hashlock",
  "a1.desc": "The secret stays in this browser only; hashlock = keccak256(secret) will be public on both chains.",
  "a1.btn": "Generate new secret",
  "a1.none": "Not generated yet",
  "a2.title": "2. Approve and lock MST on {chain}",
  "a2.bob": "Bob's address (recipient)",
  "a2.amount": "MST amount",
  "a2.t1": "T1: expires in (minutes)",
  "a2.approve": "① approve",
  "a2.lock": "② Lock MST",
  "a2.hint.connect": "Connect a wallet first",
  "a2.hint.secret": "Generate a secret first",
  "a2.hint.locked": "Locked — see the MST swap on the right",
  "a2.hint.badBob": "Invalid Bob address",
  "a2.hint.zero": "Amount must be greater than 0",
  "a2.hint.balance": "Insufficient MST balance ({balance})",
  "a2.hint.allowance": "Allowance {allowance} is too low — approve first",
  "a2.hint.ready": "Allowance {allowance} — ready to lock",
  "a3.title": "3. Verify Bob's ETH lock on {chain}",
  "a3.desc": "Send Bob the MST swap ID (on the right). Once you have Bob's ETH swap ID, verify its parameters.",
  "a3.expect": "Agreed ETH amount (optional)",
  "a3.placeholder": "e.g. 0.01",
  "verify.btn": "Read and verify",
  "a4.title": "4. Claim ETH with the secret (reveals it)",
  "a4.desc": "After claiming, the secret appears in the Claimed event on {chain}, and Bob can use it to claim the MST.",
  "a4.btn": "Claim ETH",
  "a4.hint.claimed": "Claimed — the secret is now public",
  "a4.hint.verify": "Verify the ETH lock first",

  "b1.title": "1. Verify Alice's MST lock on {chain}",
  "b1.id": "MST swap ID (from Alice)",
  "b1.expect": "Agreed MST amount (optional)",
  "b1.placeholder": "e.g. 10",
  "b2.title": "2. Lock ETH on {chain} (T2 &lt; T1)",
  "b2.desc": "The recipient and hashlock come straight from the verified MST lock — no manual entry.",
  "b2.amount": "ETH amount",
  "b2.t2": "T2: expires in (minutes)",
  "b2.btn": "Lock ETH",
  "b2.hint.t2": "T1 = {t1}; with this input T2 ≈ {t2} {verdict}",
  "b2.hint.ok": "✔ T2 < T1",
  "b2.hint.bad": "✘ must be at least {gap}s before T1",
  "b2.hint.locked": "Locked — see the ETH swap on the right",
  "b2.hint.verify": "Verify the MST lock first",
  "b3.title": "3. Wait for Alice to claim, then read the secret from {chain}",
  "b3.desc": "The page watches automatically; you can also read the Claimed event manually.",
  "b3.btn": "Read secret",
  "b3.got": "Secret obtained (keccak256 check passed)",
  "b3.none": "Not revealed yet",
  "b4.title": "4. Claim MST on {chain} with the secret",
  "b4.btn": "Claim MST",
  "b4.hint.claimed": "Claimed — swap complete",
  "b4.hint.wait": "Waiting for the secret to be revealed",

  "card.mstLock": "MST lock · {chain}",
  "card.ethLock": "ETH lock · {chain}",
  "card.notCreated": "Not created",
  "card.noId": "No swap ID yet",
  "card.loading": "Loading…",
  "card.status": "On-chain status",
  "card.amount": "Amount",
  "card.chainTime": "Chain time",
  "card.me": " (me)",
  "card.claim": "Claim",
  "card.refund": "Refund",
  "card.claimReason": "Claim: {r}",
  "card.refundReason": "Refund: {r}",
  "card.sep": "; ",
  "card.forceClaim": "Try claim anyway",
  "card.forceRefund": "Try refund anyway",
  "hold.refund": "Hold to refund",
  "hold.done": "Sent",
  "hold.hint": "Press and hold for 1.2 seconds to confirm the refund",
  "card.forceNote": "(demo: the contract rejects invalid actions)",
  "banner.done": "✔ Swap complete: both locks have been claimed",
  "banner.refunded": "↩ Swap not completed, refunded: {parts}",
  "banner.mstBack": "MST returned to Alice",
  "banner.ethBack": "ETH returned to Bob",
  "banner.join": ", ",

  "state.none": "Not found",
  "state.claimed": "Claimed",
  "state.refunded": "Refunded",
  "state.expired": "Expired · Refundable",
  "state.active": "Locked · Claimable",
  "reason.expired": "expired, cannot claim",
  "reason.notRecipient": "current account is not the recipient",
  "reason.notExpired": "not expired yet, cannot refund",
  "reason.notSender": "current account is not the sender",

  "check.active": "Swap exists and is Active (currently {status})",
  "check.recipientMe": "Recipient is the current account",
  "check.tokenMst": "Locked token is the configured MST",
  "check.amount": "Locked amount ≥ agreed amount",
  "check.hashlockNonzero": "Hashlock is non-zero",
  "check.t1Room": "T1 has {remaining}s left — enough to create an earlier-expiring ETH lock (needs > {need}s)",
  "check.nativeEth": "Asset is native ETH (token = 0x0)",
  "check.hashlockMatch": "Hashlock matches the MST lock",
  "check.t2BeforeT1": "T2 < T1 (T2 expires at least {gap}s earlier)",
  "check.t2Room": "T2 has {remaining}s left — enough time to claim",

  "err.noWallet": "No wallet detected. Install MetaMask (or add ?devwallet to the URL for local development)",
  "err.rejected": "Cancelled in the wallet",
  "err.contract": "rejected by the contract",
  "err.InvalidAddress": "invalid address (zero recipient)",
  "err.InvalidToken": "invalid token address",
  "err.InvalidAmount": "amount must be greater than 0",
  "err.InvalidHashlock": "hashlock must not be zero",
  "err.InvalidTimelock": "deadline must be later than the current chain time",
  "err.UnexpectedEther": "the contract does not accept direct ETH transfers",
  "err.SwapAlreadyExists": "swap already exists",
  "err.SwapNotFound": "swap not found (wrong swap ID or on the other chain)",
  "err.SwapNotActive": "swap already finished (claimed or refunded); cannot repeat",
  "err.UnauthorizedReceiver": "only the designated recipient can claim",
  "err.UnauthorizedSender": "only the original sender can refund",
  "err.SwapExpired": "expired, can no longer be claimed (only the sender can refund)",
  "err.SwapNotExpired": "not expired yet, cannot refund",
  "err.InvalidSecret": "wrong secret: keccak256(secret) ≠ hashlock",
  "err.ETHTransferFailed": "ETH transfer failed; state rolled back",
  "err.ReentrancyGuardReentrantCall": "reentrant call blocked",
  "err.SafeERC20FailedOperation": "token transfer failed",
  "err.ERC20InsufficientAllowance": "insufficient MST allowance — approve first",
  "err.ERC20InsufficientBalance": "insufficient MST balance",
  "err.named": "{name}: {msg}",
};

const dicts = { zh, en };
const LANG_KEY = "htlc-lang";

function initialLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    /* 隐私模式 */
  }
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

let lang = initialLang();
const listeners = [];

export const getLang = () => lang;

export function t(key, vars = {}) {
  const template = dicts[lang][key] ?? dicts.zh[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

// 存进状态的文案用它：每次被拼进模板或赋给 textContent 时按当前语言翻译
export function lazy(key, vars) {
  return { toString: () => t(key, vars) };
}

export function setLang(next) {
  if (next === lang || !dicts[next]) return;
  lang = next;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* 隐私模式 */
  }
  applyStatic();
  listeners.forEach((fn) => fn(lang));
}

export function onLangChange(fn) {
  listeners.push(fn);
}

// 页面上固定的文案：data-i18n（文本）、data-i18n-title、data-i18n-aria
export function applyStatic(root = document) {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.title = t("doc.title");
  root.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  root.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  root.querySelectorAll("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
}

// 本地链的名字跟随语言；测试网名字两种语言相同
export function chainName(chain) {
  const key = `chain.${chain.chainId}`;
  return key in dicts[lang] ? t(key) : chain.name;
}

export const timeLocale = () => (lang === "zh" ? "zh-CN" : "en-GB");
