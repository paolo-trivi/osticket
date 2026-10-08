import "server-only";

import { readFileSync } from "node:fs";

/**
 * Impostazioni di installazione condivise con osTicket PHP.
 * Fonte primaria: include/ost-config.php dell'installazione osTicket (OST_CONFIG_PATH, in sola lettura);
 * ogni valore può essere sovrascritto da variabili d'ambiente.
 */
export interface OstInstallConfig {
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPass: string;
  tablePrefix: string;
  /** Usato da Message-ID, firme URL file, cifratura credenziali email: deve essere quello del PHP. */
  secretSalt: string;
  adminEmail: string;
}

/** Estrae le define('NOME', 'valore') da ost-config.php. */
export function parseOstConfigPhp(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^\s*define\(\s*'([A-Z_]+)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\)\s*;/gm;
  for (const m of source.matchAll(re)) {
    out[m[1]] = m[2].replace(/\\(['\\])/g, "$1");
  }
  return out;
}

let cached: OstInstallConfig | undefined;

export function installConfig(): OstInstallConfig {
  if (cached) return cached;

  let php: Record<string, string> = {};
  const path = process.env.OST_CONFIG_PATH;
  if (path) php = parseOstConfigPhp(readFileSync(path, "utf8"));

  const pick = (env: string, def: string, fallback = ""): string =>
    process.env[env] ?? php[def] ?? fallback;

  // DBHOST può essere "host:porta" o "host:/path/socket" come in osTicket
  const [host, port] = pick("OST_DB_HOST", "DBHOST", "localhost").split(":");
  const config: OstInstallConfig = {
    dbHost: host === "localhost" ? "127.0.0.1" : host,
    dbPort: Number(process.env.OST_DB_PORT ?? port ?? 3306) || 3306,
    dbName: pick("OST_DB_NAME", "DBNAME"),
    dbUser: pick("OST_DB_USER", "DBUSER"),
    dbPass: pick("OST_DB_PASS", "DBPASS"),
    tablePrefix: pick("OST_TABLE_PREFIX", "TABLE_PREFIX", "ost_"),
    secretSalt: pick("OST_SECRET_SALT", "SECRET_SALT"),
    adminEmail: pick("OST_ADMIN_EMAIL", "ADMIN_EMAIL"),
  };

  if (!config.dbName || !config.dbUser) {
    throw new Error("Configurazione DB osTicket mancante: impostare OST_CONFIG_PATH oppure OST_DB_*");
  }
  if (!config.secretSalt) {
    throw new Error("SECRET_SALT mancante: impostare OST_CONFIG_PATH oppure OST_SECRET_SALT");
  }
  cached = config;
  return config;
}

/** Chiave per firmare i cookie di sessione della app Next (indipendente da osTicket). */
export function sessionSecret(): Uint8Array {
  const secret = process.env.APP_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("APP_SESSION_SECRET mancante o più corto di 32 caratteri");
  }
  return new TextEncoder().encode(secret);
}
