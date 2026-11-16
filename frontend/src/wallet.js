// 钱包连接与网络切换（MetaMask 或本地 dev wallet）。
import { BrowserProvider, toQuantity } from "ethers";
import { config, devWalletEnabled } from "./config.js";
import { createDevWallet } from "./devWallet.js";
import { chainName, t } from "./i18n.js";

const chains = [config.mstChain, config.ethChain];
let injected = null;

export function getInjected() {
  if (injected) return injected;
  if (devWalletEnabled) injected = createDevWallet(chains);
  else if (window.ethereum) injected = window.ethereum;
  return injected;
}

export const wallet = { account: null, chainId: null };

export async function connectWallet() {
  const eth = getInjected();
  if (!eth) throw new Error(t("err.noWallet"));
  const accounts = await eth.request({ method: "eth_requestAccounts" });
  wallet.account = accounts[0] || null;
  wallet.chainId = parseInt(await eth.request({ method: "eth_chainId" }), 16);
  return wallet;
}

export function onWalletChange(callback) {
  const eth = getInjected();
  if (!eth || !eth.on) return;
  eth.on("accountsChanged", (accounts) => {
    wallet.account = accounts[0] || null;
    callback();
  });
  eth.on("chainChanged", (hex) => {
    wallet.chainId = parseInt(hex, 16);
    callback();
  });
}

export function chainLabel(chainId) {
  const c = chains.find((x) => x.chainId === chainId);
  return c ? chainName(c) : t("chain.unknown", { id: chainId });
}

// 切换到目标链；钱包里没有这条链时先添加（错误码 4902）
export async function switchChain(chain) {
  const eth = getInjected();
  const hexId = toQuantity(chain.chainId);
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (err) {
    const code = err.code ?? err?.data?.originalError?.code;
    if (code !== 4902) throw err;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hexId,
          chainName: chain.name,
          rpcUrls: [chain.rpcUrl],
          nativeCurrency: chain.currency,
          blockExplorerUrls: chain.explorer ? [chain.explorer] : [],
        },
      ],
    });
  }
  wallet.chainId = chain.chainId;
}

// 发交易前确保钱包在正确的链上，然后返回该链的 signer
export async function signerOn(chain) {
  if (!wallet.account) await connectWallet();
  const eth = getInjected();
  const current = parseInt(await eth.request({ method: "eth_chainId" }), 16);
  if (current !== chain.chainId) await switchChain(chain);
  const provider = new BrowserProvider(eth, "any");
  return provider.getSigner(wallet.account);
}
