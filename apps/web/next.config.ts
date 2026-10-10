import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

import { SECURITY_HEADERS } from "./src/server/security/csp";

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  // Docker: server autonomo (NEXT_OUTPUT=standalone); dietro reverse proxy in un sotto-percorso (NEXT_BASE_PATH=/app)
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  ...(process.env.NEXT_BASE_PATH ? { basePath: process.env.NEXT_BASE_PATH } : {}),
  env: { NEXT_PUBLIC_BASE_PATH: process.env.NEXT_BASE_PATH ?? "" },
  poweredByHeader: false,
  // Le server action ricevono solo testo: gli allegati passano da /api/{agent,portal}/upload, che
  // applicano max_file_size di osTicket prima di leggere il corpo. Limite esplicito (default di Next).
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // in sviluppo la app viene aperta anche come 127.0.0.1 (HMR e idratazione)
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  webpack(config) {
    config.module.rules.push({
      test: /\.svg$/,
      use: ["@svgr/webpack"],
    });
    return config;
  },
  images: {
    localPatterns: [
      {
        pathname: "/**",
      },
    ],
  },
  turbopack: {
    root: __dirname,
    rules: {
      "*.svg": {
        loaders: ["@svgr/webpack"],
        as: "*.js",
      },
    },
  },
};

export default withNextIntl(nextConfig);
