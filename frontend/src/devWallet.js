// 仅本地开发用的 EIP-1193 "钱包"，URL 带 ?devwallet 且 profile=local 时才启用。
// 它把请求转发给本地 Hardhat 节点，由节点用自带的已解锁测试账户签名；
// 不包含、不读取任何私钥。testnet 下永远不会启用，正式演示请用 MetaMask。

export function createDevWallet(chains) {
  const byId = new Map(chains.map((c) => [c.chainId, c]));
  let chainId = chains[0].chainId;
  let account = null;
  const listeners = {};

  const emit = (event, value) => (listeners[event] || []).forEach((fn) => fn(value));

  async function rpc(method, params) {
    const res = await fetch(byId.get(chainId).rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || [] }),
    });
    const json = await res.json();
    if (json.error) {
      const err = new Error(json.error.message);
      err.code = json.error.code;
      // Hardhat 把 revert 数据放在 error.data.data，摊平后 ethers 才能解码自定义错误
      const d = json.error.data;
      err.data = d && typeof d === "object" && "data" in d ? d.data : d;
      throw err;
    }
    return json.result;
  }

  const wallet = {
    isDevWallet: true,
    async listAccounts() {
      return rpc("eth_accounts");
    },
    setAccount(addr) {
      account = addr;
      emit("accountsChanged", account ? [account] : []);
    },
    async request({ method, params }) {
      switch (method) {
        case "eth_requestAccounts":
          if (!account) account = (await rpc("eth_accounts"))[0];
          return [account];
        case "eth_accounts":
          return account ? [account] : [];
        case "eth_chainId":
          return "0x" + chainId.toString(16);
        case "wallet_switchEthereumChain": {
          const id = parseInt(params[0].chainId, 16);
          if (!byId.has(id)) {
            const err = new Error("Unrecognized chain");
            err.code = 4902;
            throw err;
          }
          if (id !== chainId) {
            chainId = id;
            emit("chainChanged", "0x" + id.toString(16));
          }
          return null;
        }
        case "wallet_addEthereumChain":
          return null;
        default:
          return rpc(method, params);
      }
    },
    on(event, fn) {
      (listeners[event] ||= []).push(fn);
    },
    removeListener(event, fn) {
      listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
    },
  };
  return wallet;
}
