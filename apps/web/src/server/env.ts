import "server-only";

import { readFileSync } from "node:fs";

import { sessionSecretProblem } from "./session-secret";

/**
 * Impostazioni di installazione condivise con osTicket PHP, da una sola fonte:
 *  - con OST_CONFIG_PATH (include/ost-config.php dell'installazione osTicket, in sola lettura) il file è
 *    la fonte dell'IDENTITÀ dell'installazione (DBNAME, TABLE_PREFIX, SECRET_SALT, ADMIN_EMAIL): una variabile
 *    d'ambiente con un valore diverso blocca l'avvio (InstallConfigError con le chiavi, senza i valori);
 *  - i dati di CONNESSIONE (OST_DB_HOST, OST_DB_PORT, OST_DB_USER, OST_DB_PASS) possono invece differire dal
 *    file: servono per un utente MySQL dedicato con soli privilegi DML e per raggiungere il DB dal container
 *    (DBHOST "localhost" del server PHP); restano in `connectionOverrides` e il doctor li segnala;
 *  - senza OST_CONFIG_PATH valgono le variabili d'ambiente OST_DB_*, OST_TABLE_PREFIX, OST_SECRET_SALT.
 * OST_CONFIG_OVERRIDE (elenco separato da virgole, es. "OST_DB_NAME") indica le variabili che vincono
 * di proposito sul file: solo per sviluppo e test (l'harness differenziale lavora su una copia del DB).
 * DBHOST con socket Unix ("localhost:/percorso/mysql.sock") non è supportato.
 */
interface OstInstallConfig {
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPass: string;
  tablePrefix: string;
  /** Usato da Message-ID, firme URL file, cifratura credenziali email: deve essere quello del PHP. */
  secretSalt: string;
  adminEmail: string;
  /** Dati di connessione presi dalle variabili d'ambiente invece che da ost-config.php (es. "OST_DB_USER"). */
  connectionOverrides: string[];
}

export class InstallConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallConfigError";
  }
}

/**
 * Estrae le define('NOME', 'valore') e define("NOME", "valore") da ost-config.php. Nei valori tra
 * virgolette doppie si risolvono \\, \" e \$ (le variabili PHP non sono interpretate).
 */
export function parseOstConfigPhp(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^\s*define\(\s*(['"])([A-Z_]+)\1\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*\)\s*;/gm;
  for (const m of source.matchAll(re)) {
    out[m[2]] = m[3] !== undefined ? m[3].replace(/\\(['\\])/g, "$1") : m[4].replace(/\\(["\\$])/g, "$1");
  }
  return out;
}

/** "host", "host:porta"; un socket ("host:/percorso", "/percorso") non è supportato. */
function splitDbHost(value: string, source: string): { host: string; port?: number } {
  const [host, port, ...rest] = value.split(":");
  if (value.startsWith("/") || rest.length || (port !== undefined && !/^\d+$/.test(port))) {
    throw new InstallConfigError(`${source}: connessione al DB tramite socket Unix non supportata, indicare host e porta TCP (es. 127.0.0.1:3306)`);
  }
  return { host, port: port ? Number(port) : undefined };
}

/** Variabili d'ambiente e define di ost-config.php corrispondenti. */
const ENV_TO_DEFINE = {
  OST_DB_NAME: "DBNAME",
  OST_DB_USER: "DBUSER",
  OST_DB_PASS: "DBPASS",
  OST_TABLE_PREFIX: "TABLE_PREFIX",
  OST_SECRET_SALT: "SECRET_SALT",
  OST_ADMIN_EMAIL: "ADMIN_EMAIL",
} as const;

/** Dati di connessione: con ost-config.php possono differire (utente dedicato, host raggiungibile dal container). */
const CONNECTION_KEYS = new Set(["OST_DB_HOST", "OST_DB_PORT", "OST_DB_USER", "OST_DB_PASS"]);

type Env = Record<string, string | undefined>;

/** Configurazione da variabili d'ambiente ed eventuale ost-config.php (puro: usato anche dai test). */
export function resolveInstallConfig(env: Env, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): OstInstallConfig {
  // variabile vuota = non impostata (i file compose passano "" per quelle non usate)
  const val = (k: string): string | undefined => (env[k] ? env[k] : undefined);
  const path = val("OST_CONFIG_PATH");
  const overrides = new Set(
    (env.OST_CONFIG_OVERRIDE ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );

  let php: Record<string, string> | null = null;
  if (path) {
    let source: string;
    try {
      source = readFile(path);
    } catch (err) {
      throw new InstallConfigError(`OST_CONFIG_PATH non leggibile (${path}): ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
    php = parseOstConfigPhp(source);
  }

  const envHost = val("OST_DB_HOST") ? splitDbHost(val("OST_DB_HOST")!, "OST_DB_HOST") : null;
  const envPortRaw = val("OST_DB_PORT");
  if (envPortRaw !== undefined && !/^\d+$/.test(envPortRaw)) throw new InstallConfigError("OST_DB_PORT non valida: indicare un numero di porta");
  const envPort = envPortRaw !== undefined ? Number(envPortRaw) : undefined;

  const connectionOverrides: string[] = [];
  let pick: (envKey: keyof typeof ENV_TO_DEFINE, fallback?: string) => string;
  let host: string;
  let port: number;
  if (php) {
    const file = php;
    const conflicts: string[] = [];
    // il DBHOST del file può essere un socket (es. PHP sullo stesso server): è un errore solo se manca OST_DB_HOST
    const parseFileHost = () => splitDbHost(file.DBHOST || "localhost", "DBHOST di ost-config.php");
    let fileHost: { host: string; port?: number } | null = null;
    try {
      fileHost = parseFileHost();
    } catch (err) {
      if (!envHost) throw err;
    }
    const filePort = fileHost?.port ?? 3306;
    host = fileHost?.host ?? "";
    port = filePort;
    if (envHost) {
      host = envHost.host;
      if (envHost.host !== fileHost?.host) connectionOverrides.push("OST_DB_HOST");
    }
    const envEffPort = envPort ?? envHost?.port;
    if (envEffPort !== undefined) {
      port = envEffPort;
      if (envEffPort !== filePort) connectionOverrides.push("OST_DB_PORT");
    }
    const chosen: Record<string, string> = {};
    for (const [envKey, def] of Object.entries(ENV_TO_DEFINE)) {
      const e = val(envKey);
      const f = file[def];
      chosen[envKey] = f ?? "";
      if (e === undefined || e === f) continue;
      if (CONNECTION_KEYS.has(envKey)) {
        chosen[envKey] = e;
        connectionOverrides.push(envKey);
      } else if (overrides.has(envKey)) chosen[envKey] = e;
      // nel file manca la define: la variabile la completa senza conflitti
      else if (f === undefined) chosen[envKey] = e;
      else conflicts.push(`${envKey} (${def})`);
    }
    if (conflicts.length) {
      throw new InstallConfigError(
        `Configurazione in conflitto: OST_CONFIG_PATH (${path}) è la fonte delle impostazioni, ma queste variabili d'ambiente ` +
          `hanno un valore diverso dal file: ${conflicts.join(", ")}. Rimuovere le variabili (o renderle uguali al file); ` +
          `solo host, porta, utente e password del DB possono differire.`,
      );
    }
    pick = (envKey, fallback = "") => chosen[envKey] || fallback;
  } else {
    host = envHost?.host ?? "localhost";
    port = envPort ?? envHost?.port ?? 3306;
    pick = (envKey, fallback = "") => val(envKey) || fallback;
  }

  const config: OstInstallConfig = {
    dbHost: host === "localhost" ? "127.0.0.1" : host,
    dbPort: port || 3306,
    dbName: pick("OST_DB_NAME"),
    dbUser: pick("OST_DB_USER"),
    dbPass: pick("OST_DB_PASS"),
    tablePrefix: pick("OST_TABLE_PREFIX", "ost_"),
    secretSalt: pick("OST_SECRET_SALT"),
    adminEmail: pick("OST_ADMIN_EMAIL"),
    connectionOverrides,
  };

  if (!config.dbName || !config.dbUser) {
    throw new InstallConfigError("Configurazione DB osTicket mancante: impostare OST_CONFIG_PATH oppure OST_DB_*");
  }
  if (!config.secretSalt) {
    throw new InstallConfigError("SECRET_SALT mancante: impostare OST_CONFIG_PATH oppure OST_SECRET_SALT");
  }
  return config;
}

let cached: OstInstallConfig | undefined;

export function installConfig(): OstInstallConfig {
  cached ??= resolveInstallConfig(process.env);
  return cached;
}

/**
 * Chiave per firmare i cookie di sessione della app Next (indipendente da osTicket). Valori di esempio
 * o deboli rifiutati (session-secret.ts); il controllo si fa anche all'avvio (instrumentation.ts).
 */
export function sessionSecret(): Uint8Array {
  const secret = process.env.APP_SESSION_SECRET;
  const problem = sessionSecretProblem(secret);
  if (problem) throw new Error(problem);
  return new TextEncoder().encode(secret);
}
