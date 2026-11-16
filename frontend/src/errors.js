// 把钱包 / RPC / 合约 revert 错误转成可读提示（中英双语）。
import { allInterfaces } from "./contracts.js";
import { lazy, t } from "./i18n.js";

// 有对应文案（err.<名称>）的合约 / OpenZeppelin 错误
const KNOWN = new Set([
  "InvalidAddress", "InvalidToken", "InvalidAmount", "InvalidHashlock", "InvalidTimelock", "UnexpectedEther",
  "SwapAlreadyExists", "SwapNotFound", "SwapNotActive", "UnauthorizedReceiver", "UnauthorizedSender",
  "SwapExpired", "SwapNotExpired", "InvalidSecret", "ETHTransferFailed", "ReentrancyGuardReentrantCall",
  "SafeERC20FailedOperation", "ERC20InsufficientAllowance", "ERC20InsufficientBalance",
]);

// text 是 lazy 对象：存进交易记录后，切换语言时会跟着变
const named = (name) => ({
  name,
  text: { toString: () => t("err.named", { name, msg: t(KNOWN.has(name) ? `err.${name}` : "err.contract") }) },
});

function findRevertData(err, depth = 0) {
  if (!err || depth > 6) return null;
  if (typeof err === "string") return /^0x[0-9a-fA-F]{8,}$/.test(err) ? err : null;
  if (typeof err !== "object") return null;
  for (const key of ["data", "error", "info", "originalError", "cause"]) {
    const found = findRevertData(err[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export function decodeError(err) {
  // 用户在钱包里拒绝
  if (err?.code === "ACTION_REJECTED" || err?.code === 4001 || err?.info?.error?.code === 4001) {
    return { name: "UserRejected", text: lazy("err.rejected") };
  }
  // ethers 已经用合约 ABI 解码出的自定义错误
  if (err?.revert?.name) {
    return named(err.revert.name);
  }
  const data = findRevertData(err);
  if (data) {
    for (const iface of allInterfaces) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) return named(parsed.name);
      } catch {
        /* 尝试下一个 ABI */
      }
    }
  }
  const msg = err?.shortMessage || err?.reason || err?.message || String(err);
  return { name: "Error", text: msg };
}
