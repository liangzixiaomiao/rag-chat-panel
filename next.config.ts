import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  serverExternalPackages: ["better-sqlite3", "sqlite-vec", "onnxruntime-node", "@huggingface/transformers"],
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
