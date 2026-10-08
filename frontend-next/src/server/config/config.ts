import "server-only";

import { cache } from "react";

import { db, type DbOrTx } from "../db";

/**
 * Lettura della tabella `config` (namespace/key/value), equivalente di Config/OsticketConfig PHP
 * (include/class.config.php). I default sono quelli di OsticketConfig::$defaults: valgono quando
 * la chiave non esiste nel DB.
 */
export const CORE_DEFAULTS: Readonly<Record<string, string | number | boolean>> = {
  allow_pw_reset: true,
  pw_reset_window: 30,
  enable_richtext: true,
  enable_avatars: true,
  allow_attachments: true,
  agent_name_format: "full",
  client_name_format: "original",
  auto_claim_tickets: true,
  auto_refer_closed: true,
  collaborator_ticket_visibility: true,
  disable_agent_collabs: false,
  require_topic_to_close: false,
  system_language: "en_US",
  default_storage_bk: "D",
  message_autoresponder_collabs: true,
  add_email_collabs: true,
  clients_only: false,
  client_registration: "closed",
  accept_unregistered_email: true,
  default_help_topic: 0,
  help_topic_sort_mode: "a",
  client_verify_email: 1,
  allow_auth_tokens: 1,
  verify_email_addrs: 1,
  client_avatar: "gravatar.mm",
  agent_avatar: "gravatar.mm",
  ticket_lock: 2,
  max_open_tickets: 0,
  files_req_auth: 1,
  force_https: "",
  allow_external_images: 0,
};

export class ConfigNamespace {
  constructor(
    readonly namespace: string,
    private readonly values: ReadonlyMap<string, string>,
    private readonly defaults: Readonly<Record<string, string | number | boolean>> = {},
  ) {}

  has(key: string): boolean {
    return this.values.has(key) || key in this.defaults;
  }

  /** Valore grezzo come lo vede il PHP: stringa dal DB, altrimenti default. */
  raw(key: string): string | number | boolean | undefined {
    return this.values.has(key) ? this.values.get(key) : this.defaults[key];
  }

  str(key: string, fallback = ""): string {
    const v = this.raw(key);
    return v === undefined || v === null ? fallback : String(v);
  }

  int(key: string, fallback = 0): number {
    const v = this.raw(key);
    if (v === undefined || v === null || v === "") return fallback;
    if (typeof v === "boolean") return v ? 1 : 0;
    const n = Number.parseInt(String(v), 10);
    return Number.isNaN(n) ? fallback : n;
  }

  /** Verità "alla PHP": "", "0", 0, false, null → false. */
  bool(key: string, fallback = false): boolean {
    const v = this.raw(key);
    if (v === undefined || v === null) return fallback;
    if (typeof v === "boolean") return v;
    return !(v === "" || v === "0" || v === 0);
  }

  /** Valori JSON (es. "lists" o configurazioni plugin). */
  json<T>(key: string, fallback: T): T {
    const v = this.str(key);
    if (!v) return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }

  entries(): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = { ...this.defaults };
    for (const [k, v] of this.values) out[k] = v;
    return out;
  }
}

export async function loadConfigNamespace(
  namespace: string,
  executor: DbOrTx = db(),
  defaults?: Readonly<Record<string, string | number | boolean>>,
): Promise<ConfigNamespace> {
  const rows = await executor
    .selectFrom("config")
    .select(["key", "value"])
    .where("namespace", "=", namespace)
    .execute();
  const values = new Map(rows.map((r) => [r.key, r.value]));
  return new ConfigNamespace(namespace, values, defaults ?? (namespace === "core" ? CORE_DEFAULTS : {}));
}

/** Configurazione `core` della richiesta corrente (una sola query per richiesta). */
export const coreConfig = cache(() => loadConfigNamespace("core"));
