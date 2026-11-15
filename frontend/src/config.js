// 网络与合约地址配置。两条链分开描述，前端分别独立读取。
const env = import.meta.env;

// 本地 Mock 配置由 frontend/dev/deploy-local.cjs 生成；文件不存在时不影响 testnet 构建
const localFiles = import.meta.glob("./config.local.json", { eager: true, import: "default" });
const localConfig = localFiles["./config.local.json"] || null;

const testnetConfig = {
  profile: "testnet",
  mstChain: {
    chainId: 11155111,
    name: "Ethereum Sepolia",
    rpcUrl: env.VITE_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
    htlc: env.VITE_ERC20HTLC_ADDRESS || "",
    mst: env.VITE_MST_ADDRESS || "",
    deployBlock: Number(env.VITE_SEPOLIA_DEPLOY_BLOCK || 0),
    currency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
  },
  ethChain: {
    chainId: 421614,
    name: "Arbitrum Sepolia",
    rpcUrl: env.VITE_ARB_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
    explorer: "https://sepolia.arbiscan.io",
    htlc: env.VITE_ETHHTLC_ADDRESS || "",
    deployBlock: Number(env.VITE_ARB_SEPOLIA_DEPLOY_BLOCK || 0),
    currency: { name: "Arbitrum Sepolia ETH", symbol: "ETH", decimals: 18 },
  },
  testAccounts: null,
};

const params = new URLSearchParams(location.search);
const wanted = params.get("profile") || env.VITE_PROFILE || (localConfig ? "local" : "testnet");

export const config =
  wanted === "local" && localConfig
    ? {
        ...localConfig,
        mstChain: { currency: { name: "ETH", symbol: "ETH", decimals: 18 }, ...localConfig.mstChain },
        ethChain: { currency: { name: "ETH", symbol: "ETH", decimals: 18 }, ...localConfig.ethChain },
      }
    : testnetConfig;

// 协议参数：ETH 锁（T2）必须比 MST 锁（T1）至少早这么多秒到期，给 Bob 留出领取 MST 的时间
export const SAFETY_GAP_SECONDS = config.profile === "local" ? 30 : 120;
// 创建/领取前要求距离到期至少还剩这么多秒，避免交易确认时已经过期
export const MIN_REMAINING_SECONDS = config.profile === "local" ? 15 : 60;

export const devWalletEnabled = config.profile === "local" && params.has("devwallet");
