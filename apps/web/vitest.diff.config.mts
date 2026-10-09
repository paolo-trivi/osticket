import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Harness differenziale PHP vs TypeScript (vedi test/diff/lib/harness.ts)
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/support/empty.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/diff/**/*.diff.test.ts"],
    setupFiles: ["./test/support/setup-env.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // il codice TypeScript lavora sulla copia "_diff_ts" del DB di sviluppo
    env: {
      OST_DB_NAME: `${process.env.OST_DIFF_SOURCE_DB ?? "osticket"}_diff${process.env.OST_DIFF_TAG ? `_${process.env.OST_DIFF_TAG}` : ""}_ts`,
      // il mailer TypeScript consegna allo stesso Mailpit del PHP
      OST_SENDMAIL_PATH:
        process.env.OST_SENDMAIL_PATH ?? `/home/user/ost-dev/bin/mailpit sendmail -S 127.0.0.1:${process.env.MAILPIT_SMTP_PORT ?? "1025"}`,
    },
  },
});
