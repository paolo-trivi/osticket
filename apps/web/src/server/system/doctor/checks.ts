import "server-only";

import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";

import { sql } from "kysely";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

import { loadConfigNamespace } from "../../config/config";
import { db } from "../../db";
import { detectDbTimezone } from "../../db/time";
import { attachmentsDir, fsStoragePath } from "../../domain/file/storage";
import { installConfig } from "../../env";
import { loadSystemEmail, localDelivery, smtpRoutesFor, type SmtpRoute } from "../../mail/mailer";
import { schemaStatus } from "../schema-compat";
import { analyzeGrants, recommendedGrant } from "./grants";
import { extractOsTicketMessageIds, saltVerdict, tallyCredentials, tallyMessageIds, type StoredCredential } from "./salt";
import { schemaVerdict } from "./schema";
import { compareOffsets, formatOffset } from "./timezone";
import { errorText, type DoctorCheck, type DoctorLevel } from "./types";

/**
 * Controlli del doctor. Ogni controllo cattura i propri errori: una query che fallisce non deve
 * buttare giù l'app, il controllo risulta "non verificabile" con il livello scelto caso per caso.
 * Nessun controllo scrive nel DB né invia email. Mai mostrare password, salt, chiavi o token.
 */
async function guarded(id: string, title: string, onError: DoctorLevel, fn: () => Promise<Omit<DoctorCheck, "id" | "title">>): Promise<DoctorCheck> {
  try {
    return { id, title, ...(await fn()) };
  } catch (ex) {
    return {
      id,
      title,
      level: onError,
      detail: `Non verificabile: ${errorText(ex)}`,
    };
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* -------------------------------------------------------------------------------------------- */
/* Connessione e firma dello schema                                                              */
/* -------------------------------------------------------------------------------------------- */

export function checkSchema(): Promise<DoctorCheck> {
  return guarded("schema", "Connessione e versione dello schema", "block", async () => {
    const ic = installConfig();
    const { rows } = await sql<{ v: string }>`SELECT VERSION() AS v`.execute(db());
    const st = schemaStatus(await loadConfigNamespace("core", db()));
    const where = `Database ${ic.dbName} su ${ic.dbHost}:${ic.dbPort} (${rows[0]?.v ?? "versione sconosciuta"}).`;
    const verdict = schemaVerdict(st);
    return { ...verdict, detail: `${where} ${verdict.detail}` };
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Prefisso delle tabelle                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** Tabelle principali che devono esistere con il prefisso configurato. */
const CORE_TABLES = [
  "config",
  "ticket",
  "ticket_status",
  "thread",
  "thread_entry",
  "thread_entry_email",
  "thread_event",
  "staff",
  "department",
  "user",
  "user_email",
  "user_account",
  "email",
  "email_account",
  "file",
  "file_chunk",
  "attachment",
  "form",
  "form_entry",
  "form_entry_values",
  "plugin",
  "syslog",
] as const;

export function checkTablePrefix(): Promise<DoctorCheck> {
  return guarded("table_prefix", "Prefisso delle tabelle", "block", async () => {
    const prefix = installConfig().tablePrefix;
    const names = CORE_TABLES.map((t) => prefix + t);
    const { rows } = await sql<{ name: string }>`
      SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${sql.join(names)})`.execute(db());
    const found = new Set(rows.map((r) => r.name));
    const missing = CORE_TABLES.filter((t) => !found.has(prefix + t));
    if (!missing.length)
      return {
        level: "ok",
        detail: `Prefisso '${prefix}': trovate tutte le ${CORE_TABLES.length} tabelle principali.`,
      };
    // prefissi presenti nello schema (dalla tabella più caratteristica di osTicket)
    const { rows: other } = await sql<{ name: string }>`
      SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE '%thread\\_entry\\_email' LIMIT 5`.execute(db());
    const prefixes = other
      .filter((r) => r.name.endsWith("thread_entry_email"))
      .map((r) => r.name.slice(0, -"thread_entry_email".length))
      .filter((p) => p !== prefix)
      .map((p) => `'${p}'`);
    return {
      level: "block",
      detail: `Prefisso '${prefix}': mancano ${plural(missing.length, "tabella", "tabelle")} (${missing.map((t) => prefix + t).join(", ")}).`,
      hint: prefixes.length
        ? `Nello schema c'è osTicket con prefisso ${prefixes.join(", ")}: correggi TABLE_PREFIX (OST_TABLE_PREFIX).`
        : "Verifica che OST_DB_NAME e TABLE_PREFIX (OST_TABLE_PREFIX) siano quelli di include/ost-config.php di osTicket.",
    };
  });
}

/* -------------------------------------------------------------------------------------------- */
/* SECRET_SALT                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** Righe recenti di thread_entry_email esaminate (per id: lettura economica anche su DB grandi). */
const MID_SCAN_ROWS = 1000;
const MID_SCAN_LIMIT = 100;

export function checkSecretSalt(): Promise<DoctorCheck> {
  // query fallita: non verificabile (avviso), come l'assenza di fonti; la discordanza invece blocca
  return guarded("secret_salt", "SECRET_SALT", "warn", async () => {
    const salt = installConfig().secretSalt;
    const executor = db();

    const addresses = (await executor.selectFrom("email").select("email").execute()).map((e) => e.email);
    const top = await executor
      .selectFrom("thread_entry_email")
      .select((eb) => eb.fn.max("id").as("m"))
      .executeTakeFirst();
    const rows = await executor
      .selectFrom("thread_entry_email")
      .select(["mid", "headers"])
      .where("id", ">", Number(top?.m ?? 0) - MID_SCAN_ROWS)
      .where((eb) => eb.or([eb("headers", "like", "%<B%"), eb("mid", "like", "B%"), eb("mid", "like", "<B%")]))
      .orderBy("id", "desc")
      .limit(MID_SCAN_LIMIT)
      .execute();
    const mids = rows.flatMap((r) => extractOsTicketMessageIds(`${r.mid ?? ""}\n${r.headers ?? ""}`));
    const midTally = tallyMessageIds(mids, salt, addresses);

    const credRows = await executor
      .selectFrom("config")
      .select(["namespace", "key", "value"])
      .where("namespace", "like", "email.%.account.%")
      .where("key", "in", ["username", "passwd", "resource_owner_email", "access_token", "refresh_token"])
      .execute();
    const byNs = new Map<string, Record<string, string>>();
    for (const r of credRows) byNs.set(r.namespace, { ...byNs.get(r.namespace), [r.key]: r.value });
    const creds: StoredCredential[] = [...byNs].map(([namespace, values]) => ({
      namespace,
      values,
    }));
    const credTally = tallyCredentials(creds, salt);

    const sources =
      `Message-ID di osTicket nelle risposte ricevute: ${midTally.match} coerenti, ${midTally.mismatch} non coerenti; ` +
      `credenziali email cifrate: ${credTally.match} decifrate, ${credTally.mismatch} non decifrabili.`;
    switch (saltVerdict(midTally, credTally)) {
      case "ok":
        return {
          level: "ok",
          detail: `Coerente con i dati di osTicket. ${sources}`,
        };
      case "mismatch":
        return {
          level: "block",
          detail: `Il SECRET_SALT configurato non corrisponde a quello usato da osTicket. ${sources}`,
          hint: "Usa lo stesso SECRET_SALT di include/ost-config.php di osTicket (OST_CONFIG_PATH oppure OST_SECRET_SALT).",
        };
      default:
        return {
          level: "warn",
          detail: "Non verificabile: nel DB non ci sono ancora risposte a email di osTicket né credenziali email cifrate.",
          hint: "Controlla a mano che il SECRET_SALT di TailTicket sia quello di include/ost-config.php di osTicket.",
        };
    }
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Fuso orario del DB                                                                            */
/* -------------------------------------------------------------------------------------------- */

export function checkTimezone(): Promise<DoctorCheck> {
  return guarded("timezone", "Fuso orario del database", "block", async () => {
    const executor = db();
    const { rows } = await sql<{
      off: number | string;
    }>`SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS off`.execute(executor);
    let appZone: string | null = null;
    let appError = "";
    try {
      appZone = await detectDbTimezone(executor);
    } catch (ex) {
      appError = errorText(ex);
    }
    const ostRow = await executor.selectFrom("config").select("value").where("namespace", "=", "core").where("key", "=", "db_timezone").executeTakeFirst();
    const ostZone = ostRow?.value ?? "";
    const cmp = compareOffsets({
      mysqlSeconds: Number(rows[0]?.off ?? 0),
      appZone,
      ostZone,
    });

    const parts = [`MySQL ${formatOffset(cmp.mysqlMinutes)}`];
    parts.push(appZone ? `TailTicket ${appZone} (${cmp.appMinutes === null ? "fuso non valido" : formatOffset(cmp.appMinutes)})` : `TailTicket non determinato (${appError})`);
    parts.push(ostZone ? `osTicket core.db_timezone ${ostZone} (${cmp.ostMinutes === null ? "fuso non valido" : formatOffset(cmp.ostMinutes)})` : "osTicket core.db_timezone assente");
    const detail = `${parts.join("; ")}.`;
    if (cmp.coherent) return { level: "ok", detail };
    const appWrong = cmp.appMinutes === null || cmp.appMinutes !== cmp.mysqlMinutes;
    return {
      level: "block",
      detail: `Offset non coerenti: ${detail}`,
      hint: appWrong
        ? "Imposta OST_DB_TIMEZONE con il fuso del server MySQL (es. Europe/Rome), lo stesso con cui osTicket scrive le date."
        : "Il fuso registrato da osTicket (core.db_timezone) non corrisponde a quello attuale del server MySQL: verifica il fuso del server DB prima di collegare TailTicket.",
    };
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Privilegi dell'utente del DB                                                                  */
/* -------------------------------------------------------------------------------------------- */

export function checkGrants(): Promise<DoctorCheck> {
  return guarded("db_grants", "Privilegi dell'utente del database", "warn", async () => {
    const schema = installConfig().dbName;
    const { rows } = await sql<Record<string, unknown>>`SHOW GRANTS FOR CURRENT_USER()`.execute(db());
    // solo l'analisi: le righe originali contengono l'hash della password
    const a = analyzeGrants(
      rows.map((r) => String(Object.values(r)[0] ?? "")),
      schema,
    );
    const hint = `Concedi solo i privilegi necessari (come amministratore del DB, sostituendo <utente> e <host>):\n${recommendedGrant(schema)}`;
    if (a.dangerous.length) {
      return {
        level: "block",
        detail: `Privilegi DDL o amministrativi non consentiti: ${a.dangerous.join(", ")}.`,
        hint,
      };
    }
    if (a.missing.length && !a.tableLevel) {
      return {
        level: "block",
        detail: `Mancano i privilegi ${a.missing.join(", ")} sullo schema ${schema}: le scritture fallirebbero.`,
        hint,
      };
    }
    const notes: string[] = [];
    if (a.tableLevel) notes.push(`${a.missing.join(", ")} concessi solo su singole tabelle: non verificati uno a uno`);
    if (a.roles.length) notes.push(`ruoli assegnati (${a.roles.join(", ")}): i loro privilegi non sono verificati`);
    if (a.unneeded.length) notes.push(`privilegi superflui: ${a.unneeded.join(", ")}`);
    if (a.unparsed) notes.push(`${plural(a.unparsed, "riga non interpretata", "righe non interpretate")}`);
    if (notes.length)
      return {
        level: "warn",
        detail: `Nessun privilegio DDL rilevato, ma: ${notes.join("; ")}.`,
        hint,
      };
    return {
      level: "ok",
      detail: `Solo SELECT, INSERT, UPDATE, DELETE sullo schema ${schema}.`,
    };
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Email in uscita                                                                               */
/* -------------------------------------------------------------------------------------------- */

const SMTP_TIMEOUT_MS = 5000;

/** Connessione, EHLO, STARTTLS e autenticazione come prima di un invio, senza inviare nulla. */
async function verifySmtp(options: SMTPTransport.Options | string): Promise<string | null> {
  const timeouts = {
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  };
  let transport;
  try {
    if (typeof options === "string") {
      // URL di nodemailer: le opzioni passano come parametri della query
      const url = new URL(options);
      for (const [k, v] of Object.entries(timeouts)) url.searchParams.set(k, String(v));
      transport = nodemailer.createTransport(url.toString());
    } else {
      transport = nodemailer.createTransport({ ...options, ...timeouts });
    }
  } catch (ex) {
    return errorText(ex);
  }
  try {
    await transport.verify();
    return null;
  } catch (ex) {
    return errorText(ex);
  } finally {
    transport.close();
  }
}

/** host:porta di un URL SMTP (mai utente e password). */
function smtpUrlHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return "URL non valido";
  }
}

export function checkOutgoingMail(): Promise<DoctorCheck> {
  return guarded("mail_outgoing", "Email in uscita", "warn", async () => {
    const executor = db();
    const core = await loadConfigNamespace("core", executor);
    const defEmail = await loadSystemEmail(core.int("default_email_id"), executor);
    const accounts = await executor
      .selectFrom("email_account as a")
      .innerJoin("email as e", "e.email_id", "a.email_id")
      .select(["a.id", "a.email_id", "a.auth_bk", "a.active", "a.host", "a.port", "e.email as address"])
      .where("a.type", "=", "smtp")
      .execute();
    const active = accounts.filter((a) => a.active);

    const problems: string[] = [];
    for (const a of active.filter((x) => x.auth_bk.toLowerCase().startsWith("oauth2"))) {
      problems.push(`account SMTP di ${a.address} con autenticazione OAuth2, non supportata da TailTicket`);
    }

    // percorsi che sendMail proverebbe: email predefinita e ogni email con un account SMTP attivo
    const routes = new Map<number, SmtpRoute>();
    const emails = [defEmail, ...(await Promise.all([...new Set(active.map((a) => a.email_id))].map((id) => loadSystemEmail(id, executor))))];
    for (const email of emails) {
      if (email === null && emails.length > 1) continue;
      for (const r of await smtpRoutesFor(email, executor)) routes.set(r.accountId, r);
    }
    const verified: string[] = [];
    await Promise.all(
      [...routes.values()].map(async (r) => {
        const where = `${r.address} (${r.host}:${r.port})`;
        if (!r.transport) {
          if (!r.authBk.toLowerCase().startsWith("oauth2")) problems.push(`account SMTP ${where}: ${r.problem}`);
          return;
        }
        const err = await verifySmtp(r.transport);
        if (err) problems.push(`connessione SMTP ${where} non riuscita: ${err}`);
        else verified.push(where);
      }),
    );

    const head = `Email predefinita: ${defEmail?.email ?? "nessuna"}.`;
    const hint = "Configura in osTicket un account SMTP con autenticazione base (utente e password) per le email di sistema, oppure verifica rete e credenziali dal container di TailTicket.";
    if (problems.length)
      return {
        level: "block",
        detail: `${head} ${capitalize(problems.join("; "))}.`,
        hint,
      };
    if (verified.length)
      return {
        level: "ok",
        detail: `${head} Connessione SMTP verificata (senza inviare nulla): ${verified.sort().join(", ")}.`,
      };

    // nessun account SMTP: il trasporto locale (come mail() di PHP)
    const local = localDelivery();
    if (local.kind === "smtp-url") {
      const where = smtpUrlHost(local.url);
      const err = await verifySmtp(local.url);
      if (err)
        return {
          level: "block",
          detail: `${head} Nessun account SMTP; OST_SMTP_URL (${where}) non raggiungibile: ${err}.`,
          hint,
        };
      return {
        level: "ok",
        detail: `${head} Nessun account SMTP: invio tramite OST_SMTP_URL (${where}), connessione verificata.`,
      };
    }
    const bin = local.command[0];
    const relayHint = "Configura un account SMTP in osTicket, oppure imposta OST_SMTP_URL (./tailticket init --attach --smtp smtp://relay:25).";
    try {
      await access(bin, constants.X_OK);
      // il "sendmail" dell'immagine (busybox, o msmtp senza configurazione) non ha un MTA locale a cui
      // consegnare: le email (risposte ai clienti comprese) andrebbero perse senza errori visibili
      if (!process.env.OST_SENDMAIL_PATH) {
        const target = await realpath(bin).catch(() => bin);
        const noRelay =
          /busybox/.test(target) ||
          (/msmtp/.test(target) &&
            !(await access("/etc/msmtprc").then(
              () => true,
              () => false,
            )));
        if (noRelay) {
          return {
            level: "block",
            detail: `${head} Nessun account SMTP e nessun relay: il comando ${bin} del container (${target}) non ha un server di posta a cui consegnare, le email di TailTicket andrebbero perse.`,
            hint: relayHint,
          };
        }
      }
      return {
        level: "warn",
        detail: `${head} Nessun account SMTP: invio tramite il comando locale ${bin}. Il recapito dipende dalla configurazione del comando e non è verificabile senza inviare.`,
        hint: relayHint,
      };
    } catch {
      return {
        level: "warn",
        detail: `${head} Nessun account SMTP e il comando ${bin} non esiste: le email di TailTicket non partirebbero.`,
        hint: "Configura un account SMTP in osTicket, oppure imposta OST_SMTP_URL o OST_SENDMAIL_PATH.",
      };
    }
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Storage degli allegati                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** Codici di file.bk: D = database (file_chunk), F = filesystem (plugin storage-fs), 6 = upload_dir di osTicket 1.6. */
function storageBackendLabel(bk: string): string {
  switch (bk) {
    case "D":
      return "database";
    case "F":
      return "filesystem";
    case "6":
      return "cartella upload_dir (osTicket 1.6)";
    default:
      return `plugin '${bk}'`;
  }
}

/** Prova a leggere il primo byte del file e ne confronta la dimensione con file.size. */
async function probeFile(path: string, size: number): Promise<string | null> {
  try {
    const st = await stat(path);
    if (!st.isFile()) return "non è un file";
    const fh = await open(path, "r");
    try {
      await fh.read(Buffer.alloc(1), 0, 1, 0);
    } finally {
      await fh.close();
    }
    return st.size === size ? null : `dimensione ${st.size} byte invece di ${size}`;
  } catch (ex) {
    return (ex as NodeJS.ErrnoException).code ?? errorText(ex);
  }
}

export function checkStorage(): Promise<DoctorCheck> {
  return guarded("storage", "Storage degli allegati", "warn", async () => {
    const executor = db();
    const counts = await executor
      .selectFrom("file")
      .select(["bk", (eb) => eb.fn.countAll<number>().as("n")])
      .groupBy("bk")
      .execute();
    const byBk = new Map(counts.map((c) => [c.bk || "D", Number(c.n)]));
    const core = await loadConfigNamespace("core", executor);
    const defaultBk = core.str("default_storage_bk") || "D";

    const list = [...byBk].map(([bk, n]) => `${n} su ${storageBackendLabel(bk)}`).join(", ") || "nessun file";
    const head = `File: ${list}. Backend predefinito di osTicket: ${storageBackendLabel(defaultBk)}.`;
    const warns: string[] = [];
    const notes: string[] = [];
    let hint: string | undefined;

    if ((byBk.get("F") ?? 0) > 0 || defaultBk === "F") {
      const dir = attachmentsDir();
      // cartella configurata nel plugin storage-fs (percorso del server PHP, non un segreto)
      const uploadPath = await executor.selectFrom("config").select("value").where("namespace", "like", "plugin.%").where("key", "=", "uploadpath").executeTakeFirst();
      hint =
        "Monta in TailTicket, in sola lettura, la cartella del plugin storage-fs" +
        (uploadPath?.value ? ` (in osTicket: ${uploadPath.value})` : "") +
        " e imposta OST_ATTACHMENTS_DIR al suo percorso.";
      if (!dir) {
        warns.push("allegati su filesystem non leggibili: monta la cartella (OST_ATTACHMENTS_DIR non impostata)");
      } else {
        const dirProblem = await stat(dir)
          .then(async (st) => (st.isDirectory() ? access(dir, constants.R_OK | constants.X_OK).then(() => null) : "non è una cartella"))
          .catch((ex: NodeJS.ErrnoException) => ex.code ?? errorText(ex));
        if (dirProblem) {
          warns.push(`allegati su filesystem non leggibili: monta la cartella (OST_ATTACHMENTS_DIR ${dir}: ${dirProblem})`);
        } else {
          const sample = await executor.selectFrom("file").select(["key", "size"]).where("bk", "=", "F").orderBy("id", "desc").limit(1).executeTakeFirst();
          if (!sample) {
            notes.push(`cartella ${dir} leggibile`);
          } else {
            // layout del plugin storage-fs: <cartella>/<iniziale della chiave>/<chiave> (storage.ts)
            const file = fsStoragePath(dir, sample.key);
            const problem = file ? await probeFile(file, Number(sample.size)) : "chiave del file non valida";
            if (problem) warns.push(`allegati su filesystem non leggibili: l'ultimo file 'F' (${dir}/${sample.key[0]}/...) non è utilizzabile: ${problem}`);
            else notes.push(`cartella ${dir} leggibile, letto l'ultimo file 'F' (layout <cartella>/<iniziale chiave>/<chiave>)`);
          }
        }
      }
    }
    const others = [...byBk].filter(([bk]) => bk !== "D" && bk !== "F");
    for (const [bk, n] of others) warns.push(`${plural(n, "file", "file")} su ${storageBackendLabel(bk)}: TailTicket non li legge`);
    if (defaultBk !== "D" && defaultBk !== "F") warns.push(`il backend predefinito ${storageBackendLabel(defaultBk)} non è supportato da TailTicket`);

    const tail = notes.length ? ` ${capitalize(notes.join("; "))}.` : "";
    if (warns.length)
      return {
        level: "warn",
        detail: `${head} ${capitalize(warns.join("; "))}.${tail}`,
        hint: hint ?? "I file di backend diversi da database e filesystem (es. S3) restano accessibili solo dal pannello di osTicket.",
      };
    return { level: "ok", detail: `${head}${tail}` };
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Plugin                                                                                        */
/* -------------------------------------------------------------------------------------------- */

type PluginKind = "auth" | "storage" | "signal";

function pluginKind(name: string, path: string): PluginKind {
  const s = `${name} ${path}`.toLowerCase();
  if (/auth|ldap|oauth|2fa|saml|\bcas\b|sso/.test(s)) return "auth";
  if (/storage|\bs3\b|\bfs\b/.test(s)) return "storage";
  return "signal";
}

const PLUGIN_ADVICE: Record<PluginKind, string> = {
  auth: "auth: chi accede tramite questi plugin non potrà accedere a TailTicket",
  storage: "storage: i file salvati da questi plugin si leggono solo se TailTicket ha accesso allo stesso storage (vedi controllo Storage)",
  signal: "signal: gli automatismi legati agli eventi (ticket creati, risposte, audit...) non partono quando scrive TailTicket",
};

export function checkPlugins(): Promise<DoctorCheck> {
  return guarded("plugins", "Plugin di osTicket", "warn", async () => {
    const rows = await db()
      .selectFrom("plugin as p")
      .leftJoin("plugin_instance as i", "i.plugin_id", "p.id")
      .select(["p.id", "p.name", "p.version", "p.isactive", "p.install_path", (eb) => eb.fn.count<number>("i.id").as("instances"), sql<number>`COALESCE(SUM(i.flags & 1), 0)`.as("enabled")])
      .groupBy(["p.id", "p.name", "p.version", "p.isactive", "p.install_path"])
      .orderBy("p.name")
      .execute();
    if (!rows.length) return { level: "ok", detail: "Nessun plugin installato." };
    const active = rows.filter((r) => r.isactive);
    const describe = (r: (typeof rows)[number]) =>
      `${r.name} ${r.version ?? ""}`.trim() + ` (${r.isactive ? "attivo" : "non attivo"}, ${plural(Number(r.enabled), "istanza abilitata", "istanze abilitate")})`;
    if (!active.length)
      return {
        level: "ok",
        detail: `Nessun plugin attivo. Installati: ${rows.map(describe).join(", ")}.`,
      };
    const kinds = [...new Set(active.map((r) => pluginKind(r.name, r.install_path)))];
    return {
      level: "warn",
      detail:
        `Plugin attivi: ${active.map(describe).join(", ")}.` +
        (rows.length > active.length
          ? ` Non attivi: ${rows
              .filter((r) => !r.isactive)
              .map((r) => r.name)
              .join(", ")}.`
          : "") +
        " I plugin girano solo nel PHP: i loro automatismi non partono quando scrive TailTicket.",
      hint: kinds.map((k) => PLUGIN_ADVICE[k]).join(".\n") + ".",
    };
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Backend di autenticazione esterni                                                             */
/* -------------------------------------------------------------------------------------------- */

/** Backend locali: NULL o "" (qualunque), "local" per gli agenti, "client" per gli utenti. */
const LOCAL_BACKENDS = ["", "local", "client"];

export function checkAuthBackends(): Promise<DoctorCheck> {
  return guarded("auth_backends", "Autenticazione esterna", "warn", async () => {
    const executor = db();
    const staff = await executor
      .selectFrom("staff")
      .select(["backend", (eb) => eb.fn.countAll<number>().as("n")])
      .where("backend", "is not", null)
      .where(sql<boolean>`LOWER(backend) NOT IN (${sql.join(LOCAL_BACKENDS)})`)
      .groupBy("backend")
      .execute();
    const users = await executor
      .selectFrom("user_account")
      .select(["backend", (eb) => eb.fn.countAll<number>().as("n")])
      .where("backend", "is not", null)
      .where(sql<boolean>`LOWER(backend) NOT IN (${sql.join(LOCAL_BACKENDS)})`)
      .groupBy("backend")
      .execute();
    const total = (rows: typeof staff) => rows.reduce((n, r) => n + Number(r.n), 0);
    const names = (rows: typeof staff) => rows.map((r) => `${r.backend}: ${r.n}`).join(", ");
    const nStaff = total(staff);
    const nUsers = total(users);
    if (!nStaff && !nUsers)
      return {
        level: "ok",
        detail: "Tutti gli agenti e gli utenti usano l'autenticazione locale di osTicket.",
      };
    const parts: string[] = [];
    if (nStaff) parts.push(`${plural(nStaff, "agente", "agenti")} con backend esterno (${names(staff)})`);
    if (nUsers) parts.push(`${plural(nUsers, "account utente", "account utente")} con backend esterno (${names(users)})`);
    return {
      level: "warn",
      detail: `${parts.join("; ")}: non potranno accedere a TailTicket.`,
      hint: "Questi account continuano ad accedere dal pannello e dal portale di osTicket; per usare TailTicket serve una password locale.",
    };
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Cron                                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** Recupero email considerato fermo dopo questo tempo senza attività. */
const FETCH_STALE_HOURS = 24;

export function checkCron(): Promise<DoctorCheck> {
  return guarded("cron", "Cron di osTicket", "warn", async () => {
    const executor = db();
    const core = await loadConfigNamespace("core", executor);
    const autocron = core.bool("enable_auto_cron");
    // api/cron.php registra "Cron Job" e scp/autocron.php "Auto Cron" solo con livello di log debug
    const lastLog = await executor
      .selectFrom("syslog")
      .select((eb) => eb.fn.max("created").as("at"))
      .where("title", "in", ["Cron Job", "Auto Cron"])
      .executeTakeFirst();
    // EmailAccount::fetchEmails aggiorna last_activity a ogni recupero riuscito
    const fetch = await executor
      .selectFrom("email_account")
      .select([(eb) => eb.fn.max("last_activity").as("at"), (eb) => eb.fn.countAll<number>().as("n")])
      .where("type", "=", "mailbox")
      .where("active", "=", 1)
      .executeTakeFirst();
    const { rows: ageRows } = fetch?.at
      ? await sql<{
          h: number;
        }>`SELECT TIMESTAMPDIFF(HOUR, ${fetch.at}, NOW()) AS h`.execute(executor)
      : { rows: [] as { h: number }[] };
    const mailboxes = Number(fetch?.n ?? 0);

    const parts = [
      autocron ? "Autocron attivo" : "Autocron non attivo",
      lastLog?.at ? `ultima esecuzione registrata del cron: ${String(lastLog.at)} (ora del DB)` : "nessuna esecuzione del cron registrata (il registro la annota solo con livello debug)",
      mailboxes
        ? fetch?.at
          ? `ultimo recupero email: ${String(fetch.at)} (${plural(mailboxes, "casella attiva", "caselle attive")})`
          : `nessun recupero email registrato (${plural(mailboxes, "casella attiva", "caselle attive")})`
        : "nessuna casella di posta da recuperare",
    ];
    const detail = `${parts.join("; ")}.`;
    const stale = mailboxes > 0 && (!fetch?.at || Number(ageRows[0]?.h ?? 0) >= FETCH_STALE_HOURS);
    const cronHint =
      "Configura un cron di sistema per osTicket (php api/cron.php ogni 5 minuti): l'autocron parte solo dalle pagine del pannello agenti PHP, e con TailTicket anche monitoraggio delle scadenze e pulizia dei file si fermano.";
    if (autocron) {
      return {
        level: "warn",
        detail: `${detail} Il recupero email dell'autocron dipende dall'attività degli agenti nel pannello PHP: si ferma se gli agenti usano TailTicket.`,
        hint: cronHint,
      };
    }
    if (stale)
      return {
        level: "warn",
        detail: `${detail} Il recupero email sembra fermo da più di ${FETCH_STALE_HOURS} ore.`,
        hint: cronHint,
      };
    return { level: "ok", detail };
  });
}
