// 协议辅助：secret/hashlock、读取 swap、由 status + 链上时间派生状态、参数核验、找 secret。
import { ZeroAddress, ZeroHash, hexlify, keccak256, randomBytes } from "ethers";
import { MIN_REMAINING_SECONDS, SAFETY_GAP_SECONDS, config } from "./config.js";
import { readContracts, readProviders } from "./contracts.js";
import { lazy, t } from "./i18n.js";

export const STATUS = ["None", "Active", "Claimed", "Refunded"];

export function newSecret() {
  return hexlify(randomBytes(32));
}

// 与合约一致：keccak256(abi.encodePacked(bytes32 secret))，即直接对 32 字节做哈希
export function hashlockOf(secret) {
  return keccak256(secret);
}

export const sameAddr = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export async function chainNow(side) {
  const block = await readProviders[side].getBlock("latest");
  return Number(block.timestamp);
}

export async function readSwap(side, swapId) {
  const { erc20Htlc, ethHtlc } = readContracts();
  const c = side === "mst" ? erc20Htlc : ethHtlc;
  const [r, now] = await Promise.all([c.getSwap(swapId), chainNow(side)]);
  return {
    side,
    swapId,
    sender: r[0],
    recipient: r[1],
    token: r[2],
    amount: r[3],
    hashlock: r[4],
    timelock: Number(r[5]),
    status: Number(r[6]),
    now,
  };
}

// 链上只存 None/Active/Claimed/Refunded；
// "可领取 / 已过期可退款" 由 status + 链上时间 + 调用者派生
const CLOSED_STATES = {
  2: { key: "claimed", label: "state.claimed" },
  3: { key: "refunded", label: "state.refunded" },
};
const NONE_STATE = { key: "none", label: "state.none" };

export function deriveState(swap, account) {
  // 只有 status === 1（Active）才继续判断；
  // 其余值（0、2、3，以及 ABI 不匹配等导致的未知值）都不允许任何操作
  if (!swap || swap.status !== 1) {
    const closed = (swap && CLOSED_STATES[swap.status]) || NONE_STATE;
    return { key: closed.key, label: t(closed.label), canClaim: false, canRefund: false };
  }

  const expired = swap.now >= swap.timelock;
  const isRecipient = sameAddr(account, swap.recipient);
  const isSender = sameAddr(account, swap.sender);

  return {
    key: expired ? "expired" : "active",
    label: t(expired ? "state.expired" : "state.active"),
    canClaim: !expired && isRecipient,
    canRefund: expired && isSender,
    claimReason: expired ? t("reason.expired") : isRecipient ? "" : t("reason.notRecipient"),
    refundReason: !expired ? t("reason.notExpired") : isSender ? "" : t("reason.notSender"),
  };
}

// Bob 在锁 ETH 之前核验 Alice 在 MST 链上的锁
export function verifyMstLock(swap, { me, expectedAmount }) {
  const remaining = swap.timelock - swap.now;
  const need = SAFETY_GAP_SECONDS + MIN_REMAINING_SECONDS;

  const isActive = swap.status === 1;
  const recipientIsMe = sameAddr(swap.recipient, me);
  const tokenIsMst = sameAddr(swap.token, config.mstChain.mst);
  const amountEnough = expectedAmount == null || swap.amount >= expectedAmount;
  const hashlockNonzero = swap.hashlock !== ZeroHash;
  // T1 剩余时间要同时覆盖 Bob 锁 ETH 所需的安全间隔，
  // 以及 Alice 揭示 secret 后 Bob 还能去 MST 链领取的最短窗口
  const hasTimeLeft = remaining > need;

  return [
    { ok: isActive, text: lazy("check.active", { status: STATUS[swap.status] }) },
    { ok: recipientIsMe, text: lazy("check.recipientMe") },
    { ok: tokenIsMst, text: lazy("check.tokenMst") },
    { ok: amountEnough, text: lazy("check.amount") },
    { ok: hashlockNonzero, text: lazy("check.hashlockNonzero") },
    { ok: hasTimeLeft, text: lazy("check.t1Room", { remaining, need }) },
  ];
}

// Alice 在领取 ETH 之前核验 Bob 在 ETH 链上的锁
export function verifyEthLock(ethSwap, { me, hashlock, mstTimelock, expectedAmount }) {
  const remaining = ethSwap.timelock - ethSwap.now;

  const isActive = ethSwap.status === 1;
  const recipientIsMe = sameAddr(ethSwap.recipient, me);
  const isNativeEth = ethSwap.token === ZeroAddress;
  const hashlockMatches = ethSwap.hashlock === hashlock;
  const amountEnough = expectedAmount == null || ethSwap.amount >= expectedAmount;
  // T2（ETH 链）必须比 T1（MST 链）至少早 SAFETY_GAP_SECONDS，
  // 保证 Bob 在 T1 之前有时间用公开的 secret 去 MST 链领取
  const t2BeforeT1 = mstTimelock != null && ethSwap.timelock + SAFETY_GAP_SECONDS <= mstTimelock;
  const hasTimeLeft = remaining > MIN_REMAINING_SECONDS;

  return [
    { ok: isActive, text: lazy("check.active", { status: STATUS[ethSwap.status] }) },
    { ok: recipientIsMe, text: lazy("check.recipientMe") },
    { ok: isNativeEth, text: lazy("check.nativeEth") },
    { ok: hashlockMatches, text: lazy("check.hashlockMatch") },
    { ok: amountEnough, text: lazy("check.amount") },
    { ok: t2BeforeT1, text: lazy("check.t2BeforeT1", { gap: SAFETY_GAP_SECONDS }) },
    { ok: hasTimeLeft, text: lazy("check.t2Room", { remaining }) },
  ];
}

// 从 ETH 链（或 MST 链）的 Claimed 事件里取出公开的 secret
export async function findRevealedSecret(side, swapId) {
  const { erc20Htlc, ethHtlc } = readContracts();
  const isMst = side === "mst";
  const contract = isMst ? erc20Htlc : ethHtlc;
  const { deployBlock } = isMst ? config.mstChain : config.ethChain;

  const [claimed] = await contract.queryFilter(
    contract.filters.Claimed(swapId),
    deployBlock || 0,
    "latest",
  );
  if (!claimed) return null;

  return { secret: claimed.args.secret, txHash: claimed.transactionHash };
}

// 从交易回执的 Locked 事件解析 swapId（不读 Solidity 返回值）
export function swapIdFromReceipt(contract, receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === "Locked") return parsed.args.swapId;
    } catch {
      /* 非本合约日志 */
    }
  }
  return null;
}
