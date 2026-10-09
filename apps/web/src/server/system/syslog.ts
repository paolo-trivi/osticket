import "server-only";

import { coreConfig } from "../config/config";
import { NOW, db, type DbOrTx } from "../db";
import { stripTags } from "../format/html";

/**
 * Log di sistema nella tabella `syslog`, come osTicket::log() (include/class.osticket.php):
 * 3 livelli (1 Error, 2 Warning, 3 Debug); si scrive solo se config core.log_level >= livello.
 * L'avviso via email all'amministratore (alertAdmin) è gestito dal chiamante quando serve.
 */
export type LogLevel = "Error" | "Warning" | "Debug";
const LEVEL_ID: Record<LogLevel, number> = { Error: 1, Warning: 2, Debug: 3 };

export async function logSystem(
  level: LogLevel,
  title: string,
  message: string,
  ip: string,
  options: { force?: boolean; executor?: DbOrTx } = {},
): Promise<boolean> {
  const cfg = await coreConfig();
  if (cfg.int("log_level") < LEVEL_ID[level] && !options.force) return false;

  await (options.executor ?? db())
    .insertInto("syslog")
    .values({
      created: NOW,
      updated: NOW,
      // Format::sanitize($title, true) / Format::sanitize($message, false)
      title: stripTags(title),
      log_type: level,
      log: message,
      ip_address: ip,
      logger: "",
    })
    .execute();
  return true;
}

export function shouldAlertAdmin(logLevel: number, level: LogLevel): boolean {
  return logLevel >= LEVEL_ID[level];
}
