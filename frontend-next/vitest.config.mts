import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // "server-only" blocca l'import fuori da React Server Components: nei test è un modulo vuoto
      "server-only": fileURLToPath(new URL("./test/support/empty.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // I test di integrazione usano il DB osTicket di sviluppo (frontend-next/dev)
    fileParallelism: false,
    setupFiles: ["./test/support/setup-env.ts"],
  },
});
