import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@mariozechner/pi-ai",
    "@mariozechner/pi-agent-core",
    "@mariozechner/pi-coding-agent",
    "@daytona/sdk",
  ],
};

export default nextConfig;
