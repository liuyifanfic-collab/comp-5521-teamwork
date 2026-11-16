import { defineConfig } from "vite";

// 允许读取仓库根目录 abi/ 下 A/B 交付的 ABI（只读引用，不复制、不修改）
export default defineConfig({
  server: { fs: { allow: [".."] } },
});
