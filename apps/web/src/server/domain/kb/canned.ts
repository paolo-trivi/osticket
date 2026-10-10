import "server-only";

import { AttachmentType } from "@/lib/osticket/object-types";

import { db, type DbOrTx } from "../../db";
import type { DbDateTime } from "../../db/schema.gen";
import { htmlToPlain } from "../../mail/mailer";
import { GlobalPerm, type Agent } from "../staff/staff";
import { objectAttachments, type KbAttachment } from "./common";
import { kbDisplayHtml } from "./html";

/**
 * Risposte predefinite lato agente, in sola lettura — doc 07 §3. Port di scp/canned.php e dei
 * template include/staff/cannedresponses.inc.php e cannedresponse.inc.php.
 */

/**
 * Risposta visibile all'agente: globale (dept 0) o di un reparto accessibile; quelle disattivate solo
 * a chi gestisce le risposte (canned.manage), come l'elenco.
 */
export function cannedAccessible(agent: Agent, canned: { dept_id: number; isenabled: number }): boolean {
  if (canned.dept_id && !agent.deptIds.includes(canned.dept_id)) return false;
  return !!canned.isenabled || agent.hasPermInAnyRole(GlobalPerm.CANNED_MANAGE);
}

export const CANNED_SORTS = ["title", "dept", "status", "updated"] as const;
export type CannedSort = (typeof CANNED_SORTS)[number];

const CANNED_SORT_COLUMNS = {
  title: "c.title",
  dept: "d.name",
  status: "c.isenabled",
  updated: "c.updated",
} as const satisfies Record<CannedSort, string>;

/** getCannedResponses: risposte dei reparti dell'agente e globali (dept 0); se `all` anche disattivate. */
export async function listCanned(
  agent: Agent,
  opts: { all?: boolean; sort?: CannedSort; order?: "asc" | "desc" } = {},
  executor: DbOrTx = db(),
) {
  let q = executor
    .selectFrom("canned_response as c")
    .leftJoin("department as d", "d.id", "c.dept_id")
    .select(["c.canned_id", "c.title", "c.isenabled", "c.dept_id", "d.name as dept", "c.lang", "c.updated"])
    .select((eb) =>
      eb
        .selectFrom("attachment as a")
        .select(eb.fn.countAll<number>().as("n"))
        .where("a.type", "=", AttachmentType.CANNED)
        .whereRef("a.object_id", "=", "c.canned_id")
        .where("a.inline", "=", 0)
        .as("files"),
    )
    .where((eb) => eb.or([eb("c.dept_id", "=", 0), eb("c.dept_id", "in", agent.deptIds.length ? [...agent.deptIds] : [0])]));
  if (!opts.all) q = q.where("c.isenabled", "=", 1);
  const order = opts.order === "desc" ? "desc" : "asc";
  q = q.orderBy(CANNED_SORT_COLUMNS[opts.sort ?? "title"], order);
  if (opts.sort && opts.sort !== "title") q = q.orderBy("c.title");
  const rows = await q.orderBy("c.canned_id").execute();
  return rows.map((r) => ({ ...r, files: Number(r.files ?? 0) }));
}

interface CannedDetail {
  id: number;
  title: string;
  isEnabled: boolean;
  deptId: number;
  dept: string | null;
  lang: string;
  responseHtml: string;
  /** Canned::getPlainText(): Format::html2text (larghezza 90) */
  responseText: string;
  notesHtml: string;
  created: DbDateTime;
  updated: DbDateTime;
  attachments: KbAttachment[];
}

/** Dettaglio di una risposta predefinita (cannedresponse.inc.php in sola lettura); null se non accessibile. */
export async function getCanned(agent: Agent, cannedId: number, executor: DbOrTx = db()): Promise<CannedDetail | null> {
  if (!Number.isInteger(cannedId) || cannedId <= 0) return null;
  const row = await executor
    .selectFrom("canned_response as c")
    .leftJoin("department as d", "d.id", "c.dept_id")
    .select(["c.canned_id", "c.title", "c.response", "c.notes", "c.isenabled", "c.dept_id", "d.name as dept", "c.lang", "c.created", "c.updated"])
    .where("c.canned_id", "=", cannedId)
    .executeTakeFirst();
  if (!row || !cannedAccessible(agent, row)) return null;
  const attachments = await objectAttachments(AttachmentType.CANNED, cannedId, executor);
  return {
    id: row.canned_id,
    title: row.title,
    isEnabled: !!row.isenabled,
    deptId: row.dept_id,
    dept: row.dept,
    lang: row.lang,
    responseHtml: kbDisplayHtml(row.response),
    responseText: htmlToPlain(row.response),
    notesHtml: kbDisplayHtml(row.notes),
    created: row.created,
    updated: row.updated,
    attachments: attachments.filter((a) => !a.inline),
  };
}
