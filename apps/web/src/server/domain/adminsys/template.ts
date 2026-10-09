import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { sql } from "kysely";

import { NOW, table, type DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { localizeInlineImages } from "../../format/text";
import { isNumeric, isset, phpLooseEquals, str, truthy, type PhpVars } from "../../php/values";
import { deleteDraftsForNamespace } from "../drafts";
import { sanitizeHtml as sanitizeText } from "./sanitize";
import type { MassResult, SaveResult } from "../admin/common";
import type { Errors } from "../admin/validator";

/**
 * Template email: scp/templates.php → EmailTemplateGroup (gruppi, SQL diretto) e EmailTemplate
 * (singoli messaggi) di include/class.template.php.
 *
 * Stranezze del PHP replicate:
 * - EmailTemplate::update → GenericAttachments::keepOnlyFileIds riceve una lista di id file e la
 *   controlla per chiave (indice): le immagini inline del template vengono quasi sempre staccate e,
 *   con più immagini nel corpo, può essere creato un allegato con file_id = indice e nome = id file;
 * - "implement" cancella le bozze del namespace `tpl.<codice><tpl_id>` (manca il punto): di fatto
 *   nessuna;
 * - l'oggetto del messaggio non è sanificato, il corpo sì (Format::sanitize).
 * "Ripristina il testo di sistema" è solo un aiuto dell'interfaccia (testo iniziale dal file YAML
 * dell'installazione PHP, come il form "implement"): il salvataggio passa da updatetpl.
 */
export const TEMPLATE_GROUPS = ["sys", "a.ticket.user", "b.ticket.staff", "c.task"] as const;

export const TEMPLATE_NAMES: Record<string, { group: string; context: string[] }> = {
  "ticket.autoresp": { group: "a.ticket.user", context: ["ticket", "signature", "message", "recipient"] },
  "ticket.autoreply": { group: "a.ticket.user", context: ["ticket", "signature", "response", "recipient"] },
  "message.autoresp": { group: "a.ticket.user", context: ["ticket", "signature", "recipient"] },
  "ticket.notice": { group: "a.ticket.user", context: ["ticket", "signature", "recipient", "staff", "message"] },
  "ticket.overlimit": { group: "a.ticket.user", context: ["ticket", "signature"] },
  "ticket.reply": { group: "a.ticket.user", context: ["ticket", "signature", "response", "staff", "poster", "recipient"] },
  "ticket.activity.notice": { group: "a.ticket.user", context: ["ticket", "signature", "message", "poster", "recipient"] },
  "ticket.alert": { group: "b.ticket.staff", context: ["ticket", "recipient", "message"] },
  "message.alert": { group: "b.ticket.staff", context: ["ticket", "recipient", "message", "poster"] },
  "note.alert": { group: "b.ticket.staff", context: ["ticket", "recipient", "note", "comments", "activity"] },
  "assigned.alert": { group: "b.ticket.staff", context: ["ticket", "recipient", "comments", "assignee", "assigner"] },
  "transfer.alert": { group: "b.ticket.staff", context: ["ticket", "recipient", "comments", "staff"] },
  "ticket.overdue": { group: "b.ticket.staff", context: ["ticket", "recipient", "comments"] },
  "task.alert": { group: "c.task", context: ["task", "recipient", "message"] },
  "task.activity.notice": { group: "c.task", context: ["task", "signature", "message", "poster", "recipient"] },
  "task.activity.alert": { group: "c.task", context: ["task", "recipient", "note", "comments", "activity"] },
  "task.assignment.alert": { group: "c.task", context: ["task", "recipient", "comments", "assignee", "assigner"] },
  "task.transfer.alert": { group: "c.task", context: ["task", "recipient", "note", "comments", "activity"] },
  "task.overdue.alert": { group: "c.task", context: ["task", "recipient", "comments"] },
};

/** EmailTemplateGroup::load: riga + numero di reparti che la usano. */
export async function loadGroup(executor: DbOrTx, id: number) {
  const row = await executor.selectFrom("email_template_group").selectAll().where("tpl_id", "=", id).executeTakeFirst();
  if (!row) return null;
  const depts = await executor.selectFrom("department").select((eb) => eb.fn.countAll<number>().as("n")).where("tpl_id", "=", id).executeTakeFirstOrThrow();
  return { ...row, depts: Number(depts.n) };
}

async function defaultTemplateId(executor: DbOrTx): Promise<number> {
  const r = await executor.selectFrom("config").select("value").where("namespace", "=", "core").where("key", "=", "default_template_id").executeTakeFirst();
  return Number(r?.value ?? 0) || 0;
}

/** EmailTemplateGroup::isInUse */
async function isInUse(executor: DbOrTx, g: { tpl_id: number; depts: number }): Promise<boolean> {
  return g.depts > 0 || g.tpl_id === (await defaultTemplateId(executor));
}

/** EmailTemplateGroup::lookup($id): id numerico esistente. */
async function lookupGroup(executor: DbOrTx, id: unknown) {
  if (!truthy(id as string) || !isNumeric(id as string)) return null;
  const g = await loadGroup(executor, Math.trunc(Number(id)));
  return g && phpLooseEquals(g.tpl_id, id) ? g : null;
}

/** EmailTemplateGroup::save($id, $vars, $errors) */
async function saveGroup(executor: DbOrTx, id: number, vars: PhpVars, errors: Errors): Promise<number | false> {
  const name = stripTags(str(vars.name).trim());
  let source: Awaited<ReturnType<typeof lookupGroup>> = null;
  if (id && !phpLooseEquals(id, vars.tpl_id ?? null)) errors.err = "internal";
  if (!truthy(name)) errors.name = "name_required";
  else {
    const other = await executor.selectFrom("email_template_group").select("tpl_id").where("name", "=", name).executeTakeFirst();
    if (other && other.tpl_id !== id) errors.name = "name_exists";
  }
  if (!id && truthy(vars.tpl_id) && !(source = await lookupGroup(executor, vars.tpl_id))) errors.tpl_id = "invalid_set";
  if (Object.keys(errors).length) return false;

  const values: Record<string, unknown> = {
    updated: NOW,
    name,
    isactive: vars.isactive === undefined ? null : str(vars.isactive),
    notes: sanitizeText(str(vars.notes)),
  };
  if (truthy(vars.lang_id)) values.lang = str(vars.lang_id);
  if (id) {
    await executor.updateTable("email_template_group").set(values).where("tpl_id", "=", id).execute();
    return id;
  }
  if (isset(vars, "id")) values.tpl_id = str(vars.id);
  const res = await executor
    .insertInto("email_template_group")
    .values({ created: NOW, ...values } as never)
    .executeTakeFirst();
  const newId = Number(res.insertId);
  if (source) {
    await sql`INSERT INTO ${table("email_template")} (created, updated, tpl_id, code_name, subject, body)
      SELECT NOW() as created, NOW() as updated, ${newId} as tpl_id, code_name, subject, body
      FROM ${table("email_template")} WHERE tpl_id=${source.tpl_id}`.execute(executor);
  }
  return newId;
}

/** scp/templates.php do=add → EmailTemplateGroup::add (nuovo set, eventualmente clonato) */
export async function addTemplateGroup(executor: DbOrTx, vars: PhpVars): Promise<SaveResult> {
  const errors: Errors = {};
  // scp/templates.php: $_REQUEST['tpl_id'] viene cercato prima del ramo POST
  if (truthy(vars.tpl_id) && !(await lookupGroup(executor, vars.tpl_id))) errors.err = "unknown_set";
  const id = await saveGroup(executor, 0, vars, errors);
  return id ? { ok: true, id, errors } : { ok: false, errors };
}

/** scp/templates.php do=update → EmailTemplateGroup::update */
export async function updateTemplateGroup(executor: DbOrTx, tplId: number, vars: PhpVars): Promise<SaveResult> {
  const g = await lookupGroup(executor, tplId);
  if (!g) return { ok: false, errors: { err: "unknown" } };
  const errors: Errors = {};
  if (!truthy(vars.isactive) && (await isInUse(executor, g))) errors.isactive = "in_use";
  const ok = await saveGroup(executor, tplId, vars, errors);
  return ok ? { ok: true, id: tplId, errors } : { ok: false, errors };
}

export type TemplateMassAction = "enable" | "disable" | "delete";

/** scp/templates.php do=mass_process */
export async function massTemplateGroups(executor: DbOrTx, action: TemplateMassAction, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select_one" };
  let num = 0;
  if (action === "enable") {
    // db_affected_rows() di mysqli: righe cambiate
    const n = await executor.selectFrom("email_template_group").select((eb) => eb.fn.countAll<number>().as("n")).where("tpl_id", "in", ids).where("isactive", "<>", 1).executeTakeFirstOrThrow();
    await sql`UPDATE ${table("email_template_group")} SET isactive=1 WHERE tpl_id IN (${sql.join(ids)})`.execute(executor);
    num = Number(n.n);
  } else {
    for (const id of ids) {
      const g = await lookupGroup(executor, id);
      if (!g || (await isInUse(executor, g))) continue;
      if (action === "disable") {
        // setStatus(0): UPDATE … updated=NOW() (la riga cambia sempre per via di updated)
        await executor.updateTable("email_template_group").set({ updated: NOW, isactive: 0 }).where("tpl_id", "=", id).execute();
        num++;
      } else {
        await executor.deleteFrom("email_template_group").where("tpl_id", "=", id).execute();
        await executor.updateTable("department").set({ tpl_id: 0 }).where("tpl_id", "=", id).execute();
        await sql`DELETE a.* FROM ${table("attachment")} a JOIN ${table("email_template")} t ON (a.object_id=t.id AND a.type='T') WHERE t.tpl_id=${id}`.execute(executor);
        await executor.deleteFrom("email_template").where("tpl_id", "=", id).execute();
        num++;
      }
    }
  }
  return num ? { ok: true, num } : { ok: false, num: 0, error: "failed" };
}

/** Draft::getAttachmentIds($body): file citati come "cid:<chiave>" nel corpo. */
async function inlineFileIds(executor: DbOrTx, body: string): Promise<{ id: number; name: string }[]> {
  const keys = [...localizeInlineImages(body).matchAll(/"cid:([\w.-]{32})"/g)].map((m) => m[1]);
  if (!keys.length) return [];
  const files = await executor.selectFrom("file").select(["id", "name"]).where("key", "in", keys).orderBy("id").execute();
  return files;
}

/** GenericAttachments::upload($files, $inline) per gli allegati di tipo T del template. */
async function uploadAttachments(executor: DbOrTx, objectId: number, files: { id: number; name: string | number }[]): Promise<void> {
  let filename: string | number | null = null;
  for (const f of files) {
    if (!f.id) continue; // AttachmentFile::create() senza dati: nessun file
    filename = f.name;
    const file = await executor.selectFrom("file").select("name").where("id", "=", f.id).executeTakeFirst();
    const name = filename !== null && filename !== "" && file && file.name.toLowerCase() !== String(filename).toLowerCase() ? String(filename) : null;
    await executor
      .insertInto("attachment")
      .values({ object_id: objectId, type: "T", file_id: f.id, inline: 1, ...(name !== null ? { name } : {}) } as never)
      .execute();
  }
}

/** EmailTemplate::save($id, $vars, $errors) */
async function saveTemplate(executor: DbOrTx, id: number, vars: PhpVars, errors: Errors): Promise<number | null | false> {
  if (!truthy(vars.subject)) errors.subject = "subject_required";
  if (!truthy(vars.body)) errors.body = "body_required";
  if (!id) {
    if (!truthy(vars.tpl_id)) errors.tpl_id = "set_required";
    if (!truthy(vars.code_name)) errors.code_name = "code_name_required";
  }
  if (Object.keys(errors).length) return false;
  const body = sanitizeText(str(vars.body), false);
  if (id) {
    await executor.updateTable("email_template").set({ updated: NOW, subject: str(vars.subject), body }).where("id", "=", id).execute();
    return id;
  }
  const res = await executor
    .insertInto("email_template")
    .values({ created: NOW, updated: NOW, tpl_id: str(vars.tpl_id) as never, code_name: str(vars.code_name), subject: str(vars.subject), body })
    .executeTakeFirst();
  return Number(res.insertId) || null;
}

/** scp/templates.php do=updatetpl → EmailTemplate::update + Draft::deleteForNamespace */
export async function updateTemplate(executor: DbOrTx, id: number, vars: PhpVars): Promise<SaveResult> {
  const tpl = await executor.selectFrom("email_template").selectAll().where("id", "=", id).executeTakeFirst();
  if (!tpl) return { ok: false, errors: { err: "unknown" } };
  const errors: Errors = {};
  if (!(await saveTemplate(executor, id, vars, errors))) return { ok: false, errors };
  const saved = await executor.selectFrom("email_template").select("body").where("id", "=", id).executeTakeFirstOrThrow();
  // keepOnlyFileIds($keepers, true): lista di id controllata per chiave (bug PHP replicato)
  const keepers = (await inlineFileIds(executor, saved.body)).map((f) => f.id);
  const ids = new Map<number, number>(keepers.map((fid, i) => [i, fid]));
  const attachments = await executor.selectFrom("attachment").select(["id", "file_id", "inline", "lang"]).where("object_id", "=", id).where("type", "=", "T").orderBy("id").execute();
  for (const a of attachments) {
    if (!ids.has(a.file_id) && !a.lang && a.inline) await executor.deleteFrom("attachment").where("id", "=", a.id).execute();
    ids.delete(a.file_id);
  }
  await uploadAttachments(executor, id, [...ids.entries()].map(([index, fid]) => ({ id: index, name: fid })));
  await deleteDraftsForNamespace(executor, `tpl.${tpl.code_name}.${tpl.tpl_id}`);
  return { ok: true, id, errors: {} };
}

/** scp/templates.php do=implement → EmailTemplate::add (messaggio non ancora definito nel set) */
export async function implementTemplate(executor: DbOrTx, tplId: number, vars: PhpVars, staffId: number): Promise<SaveResult> {
  if (!(await lookupGroup(executor, tplId))) return { ok: false, errors: { err: "unknown" } };
  const errors: Errors = {};
  const id = await saveTemplate(executor, 0, vars, errors);
  if (!id) return { ok: false, errors };
  const tpl = await executor.selectFrom("email_template").selectAll().where("id", "=", id).executeTakeFirst();
  if (!tpl) return { ok: false, errors };
  const files = await inlineFileIds(executor, tpl.body);
  await uploadAttachments(executor, id, files);
  await deleteDraftsForNamespace(executor, `tpl.${tpl.code_name}${tpl.tpl_id}`, staffId);
  return { ok: true, id, errors: {} };
}

/**
 * YAML minimo dei file di dati iniziali di osTicket: chiavi di primo livello con valore semplice o
 * blocco letterale "|" (righe indentate, indentazione comune rimossa).
 */
function parseSimpleYaml(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const [, key, rest] = m;
    if (rest.trim() !== "|") {
      out[key] = rest.trim().replace(/^(['"])(.*)\1$/, "$2");
      continue;
    }
    const block: string[] = [];
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) block.push(lines[++i]);
    while (block.length && block[block.length - 1].trim() === "") block.pop();
    const indent = Math.min(...block.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
    out[key] = `${block.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n")}\n`;
  }
  return out;
}

/** Testo iniziale del template (EmailTemplate::fromInitialData) dal file YAML dell'installazione PHP. */
export function initialTemplate(code: string, lang = "en_US"): { subject: string; body: string } | null {
  if (!TEMPLATE_NAMES[code]) return null;
  const cfgPath = process.env.OST_CONFIG_PATH;
  if (!cfgPath) return null;
  for (const l of [lang, "en_US"]) {
    const file = join(dirname(cfgPath), "i18n", l, "templates", "email", `${code}.yaml`);
    if (!existsSync(file)) continue;
    const data = parseSimpleYaml(readFileSync(file, "utf8"));
    if (typeof data.subject === "string" && typeof data.body === "string") return { subject: data.subject.trim(), body: data.body };
  }
  return null;
}

export async function listTemplateGroups(executor: DbOrTx) {
  const groups = await executor.selectFrom("email_template_group").selectAll().orderBy("name").execute();
  const def = await defaultTemplateId(executor);
  const out = [];
  for (const g of groups) {
    const depts = await executor.selectFrom("department").select((eb) => eb.fn.countAll<number>().as("n")).where("tpl_id", "=", g.tpl_id).executeTakeFirstOrThrow();
    out.push({ ...g, depts: Number(depts.n), isDefault: g.tpl_id === def });
  }
  return out;
}

export async function groupTemplates(executor: DbOrTx, tplId: number) {
  return executor.selectFrom("email_template").select(["id", "code_name", "subject", "updated"]).where("tpl_id", "=", tplId).orderBy("code_name").execute();
}
