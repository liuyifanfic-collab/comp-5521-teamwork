// 合约 ABI 与只读 Provider。ABI 直接引用 A/B 在 abi/ 下的交付件。
import { Contract, Interface, JsonRpcProvider, Network } from "ethers";
import erc20HtlcAbi from "../../abi/ERC20HTLC.abi.json";
import ethHtlcAbi from "../../abi/ETHHTLC.abi.json";
import { config } from "./config.js";

// MST 只需要标准 ERC20 函数 + OpenZeppelin v5 的错误定义（用于解码 approve/余额不足）
export const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidApprover(address approver)",
  "error ERC20InvalidSpender(address spender)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidReceiver(address receiver)",
];

export { erc20HtlcAbi, ethHtlcAbi };
export const allInterfaces = [new Interface(erc20HtlcAbi), new Interface(ethHtlcAbi), new Interface(erc20Abi)];

// 两条链各自一个只读 provider：状态观察不依赖钱包当前所在的网络
function makeReadProvider(chain) {
  const network = Network.from({ chainId: chain.chainId, name: chain.name });
  return new JsonRpcProvider(chain.rpcUrl, network, { staticNetwork: network, pollingInterval: 2000 });
}

export const readProviders = {
  mst: makeReadProvider(config.mstChain),
  eth: makeReadProvider(config.ethChain),
};

export function readContracts() {
  return {
    erc20Htlc: new Contract(config.mstChain.htlc, erc20HtlcAbi, readProviders.mst),
    mst: new Contract(config.mstChain.mst, erc20Abi, readProviders.mst),
    ethHtlc: new Contract(config.ethChain.htlc, ethHtlcAbi, readProviders.eth),
  };
}
