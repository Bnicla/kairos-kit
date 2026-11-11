import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Local dashboard reads ~/Kairos via the fs-based store in server components.
  // Keep the heavy server-only render deps out of the client bundle.
  serverExternalPackages: ["puppeteer-core", "@sparticuz/chromium", "docx", "unpdf"],
};

export default nextConfig;
