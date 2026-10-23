import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // ssh2 ships an optional native crypto binding the bundler cannot place; load it with Node's require instead.
  serverExternalPackages: ["ssh2"],
};

export default nextConfig;
