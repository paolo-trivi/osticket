import "server-only";

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Internationalization::availableLanguages(): cartelle e .phar in include/i18n dell'installazione PHP. */
export function installedLanguages(): string[] {
  const cfgPath = process.env.OST_CONFIG_PATH;
  const out = new Set<string>();
  if (cfgPath) {
    const dir = join(dirname(cfgPath), "i18n");
    try {
      if (existsSync(dir))
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory() && /^[a-z]{2}(_[A-Za-z0-9]+)?$/.test(e.name)) out.add(e.name.toLowerCase());
          else if (e.isFile() && e.name.endsWith(".phar")) out.add(e.name.slice(0, -5).toLowerCase());
        }
    } catch {
      /* cartella non leggibile: solo la lingua di base */
    }
  }
  if (!out.size) out.add("en_us");
  return [...out];
}
