import "server-only";

import type { ConfigNamespace } from "../../config/config";
import { db, type DbOrTx } from "../../db";
import { detectDbTimezone } from "../../db/time";
import { safeHtml } from "../../format/sanitize";
import { buildTicketVars, companyVar } from "../../mail/objects";
import { VariableReplacer } from "../../mail/variables";
import { contentPage } from "./kb";

/**
 * Dati di supporto alle pagine del portale: help topic pubblici (Topic::getPublicHelpTopics) e pagina
 * di ringraziamento dopo l'apertura (open.php: pagina del topic o thank-you_page_id con le variabili
 * del ticket).
 */

/** Topic::getHelpTopics(publicOnly): pubblici e attivi (disattivazione ereditata dal padre), nome completo */
export async function publicTopics(cfg: ConfigNamespace, executor: DbOrTx = db()): Promise<{ id: number; name: string }[]> {
  const rows = await executor.selectFrom("help_topic").select(["topic_id", "topic_pid", "ispublic", "flags", "topic", "sort"]).orderBy("sort").execute();
  const byId = new Map(rows.map((r) => [r.topic_id, r]));
  const out: { id: number; name: string; sort: number }[] = [];
  for (const t of rows) {
    let name = t.topic;
    let disabled = !((t.flags ?? 0) & 0x0002);
    const seen = new Set([t.topic_id]);
    let cur = t;
    let parent: typeof t | undefined;
    while (cur.topic_pid && byId.has(cur.topic_pid) && !seen.has(cur.topic_pid)) {
      const p = byId.get(cur.topic_pid)!;
      name = `${p.topic} / ${name}`;
      if (parent && !((parent.flags ?? 0) & 0x0002)) disabled = true;
      seen.add(p.topic_id);
      parent = p;
      cur = p;
    }
    if (!t.ispublic || disabled) continue;
    out.push({ id: t.topic_id, name, sort: t.sort });
  }
  if (cfg.str("help_topic_sort_mode") !== "m") out.sort((a, b) => a.name.localeCompare(b.name));
  return out.map(({ id, name }) => ({ id, name }));
}

/** Pagina di ringraziamento del ticket appena creato (HTML sanificato con le variabili sostituite) */
export async function thankYouHtml(cfg: ConfigNamespace, ticketId: number, executor: DbOrTx = db()): Promise<string | null> {
  const t = await executor.selectFrom("ticket as t").leftJoin("help_topic as h", "h.topic_id", "t.topic_id").select(["h.page_id"]).where("t.ticket_id", "=", ticketId).executeTakeFirst();
  const page = (await contentPage(t?.page_id ?? 0, executor)) ?? (await contentPage(cfg.int("thank-you_page_id"), executor));
  if (!page) return null;
  const tv = await buildTicketVars(executor, ticketId, cfg, await detectDbTimezone(executor));
  if (!tv) return null;
  const r = new VariableReplacer().assign({ ticket: tv.ticket, recipient: tv.ownerVar, url: cfg.str("helpdesk_url").replace(/\/+$/, ""), company: await companyVar(executor) });
  return safeHtml(r.replaceVars(page.body));
}

/**
 * Pagina di contenuto per tipo con le variabili di sistema sostituite (osTicket::replaceTemplateVariables:
 * url, company) e HTML sanificato: banner-client, registration-confirm, registration-thanks.
 */
export async function renderedContent(cfg: ConfigNamespace, type: string, executor: DbOrTx = db()): Promise<{ title: string; html: string } | null> {
  const { contentPageByType } = await import("./kb");
  const page = await contentPageByType(type, executor);
  if (!page) return null;
  const r = new VariableReplacer().assign({ url: cfg.str("helpdesk_url").replace(/\/+$/, ""), company: await companyVar(executor) });
  return { title: r.replaceVars(page.name), html: safeHtml(r.replaceVars(page.body)) };
}

/**
 * Valori attuali del form utente per il profilo (chiavi `f.<id>` dei renderer): nome ed email dal
 * record utente (campi esterni), gli altri dalle risposte salvate.
 */
export async function profileFormValues(cfg: ConfigNamespace, userId: number, executor: DbOrTx = db()): Promise<Record<string, string[]>> {
  const { loadFormDef } = await import("../forms/load");
  const { cleanFromDb, fieldToString } = await import("../forms/fields");
  const def = await loadFormDef(executor, cfg, { type: "U" }, "client");
  if (!def) return {};
  const u = await executor
    .selectFrom("user as u")
    .leftJoin("user_email as e", "e.id", "u.default_email_id")
    .select(["u.name", "e.address"])
    .where("u.id", "=", userId)
    .executeTakeFirst();
  const vals = await executor
    .selectFrom("form_entry as fe")
    .innerJoin("form_entry_values as v", "v.entry_id", "fe.id")
    .select(["v.field_id", "v.value", "v.value_id"])
    .where("fe.object_type", "=", "U")
    .where("fe.object_id", "=", userId)
    .execute();
  const out: Record<string, string[]> = {};
  for (const f of def.fields) {
    const key = `f.${f.id}`;
    if (f.name === "name") out[key] = [u?.name ?? ""];
    else if (f.name === "email") out[key] = [u?.address ?? ""];
    else {
      const v = vals.find((x) => x.field_id === f.id);
      if (!v) continue;
      const clean = cleanFromDb(f, v.value, v.value_id);
      if (f.type === "phone" && typeof clean === "string") {
        const [num, ext] = clean.split("X", 2);
        out[key] = [num];
        if (ext) out[`${key}-ext`] = [ext];
      } else if (clean && typeof clean === "object" && !("id" in clean)) out[key] = Object.keys(clean);
      else out[key] = [fieldToString(f, clean)];
    }
  }
  return out;
}

/** Lingue configurate (system_language + secondary_langs) per la preferenza del cliente */
export function configuredLanguages(cfg: ConfigNamespace): string[] {
  const secondary = cfg.str("secondary_langs").split(",").map((s) => s.trim()).filter(Boolean);
  return secondary.length ? [cfg.str("system_language", "en_US"), ...secondary] : [];
}
