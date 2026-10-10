import "server-only";

import { AttachmentType, ObjectType } from "@/lib/osticket/object-types";

import { db, type DbOrTx } from "../../db";
import { cannedAccessible, faqVisibleToAgent } from "../kb/kb";
import type { Agent } from "../staff/staff";
import { checkTaskPerm, loadTask } from "../task/tasks";
import { checkStaffPerm, loadTicket } from "../ticket/ticket";

interface AgentFileRef {
  fileId: number;
  /** nome dell'allegato (attachment.name) se diverso da quello del file */
  name: string | null;
}

/** Chiave di file accettata nell'URL (file.key: 32 caratteri [A-Za-z0-9_-], margine per vecchi dati). */
function isValidFileKey(key: string): boolean {
  return /^[\w-]{1,64}$/.test(key);
}

/**
 * Equivalente dei controlli di file.php per una sessione agente: in osTicket il download è
 * autorizzato dal link firmato, prodotto solo dalle pagine che l'agente può vedere. Qui il file
 * (identificato dalla chiave, usata anche nei riferimenti `cid:`) è servito se almeno uno degli
 * oggetti a cui è allegato è visibile all'agente:
 * - H: voce di thread di un ticket visibile (checkStaffPerm) o di un task visibile (checkTaskPerm);
 * - F: FAQ visibile nelle pagine KB dell'agente (filtro per help topic);
 * - C: risposta predefinita globale o di un reparto accessibile (attiva, o qualsiasi con canned.manage);
 * - immagine inline citata (`cid:<chiave>`) nella descrizione di una categoria KB.
 * Gli altri tipi (modelli email, pagine, loghi…) non passano da questa route.
 */
export async function agentFileRef(agent: Agent, key: string, executor: DbOrTx = db()): Promise<AgentFileRef | null> {
  if (!isValidFileKey(key)) return null;
  const refs = await executor
    .selectFrom("file as f")
    .innerJoin("attachment as a", "a.file_id", "f.id")
    .leftJoin("thread_entry as e", (j) => j.onRef("e.id", "=", "a.object_id").on("a.type", "=", AttachmentType.THREAD_ENTRY))
    .leftJoin("thread as th", "th.id", "e.thread_id")
    .select(["f.id as file_id", "a.type", "a.object_id", "a.name", "th.object_id as thread_object_id", "th.object_type as thread_object_type"])
    .where("f.key", "=", key)
    .where("a.type", "in", [AttachmentType.THREAD_ENTRY, AttachmentType.FAQ, AttachmentType.CANNED])
    .orderBy("a.id")
    .execute();

  for (const ref of refs) {
    if (await canSee(agent, ref, executor)) return { fileId: ref.file_id, name: ref.name };
  }
  // Immagini inline della descrizione di una categoria KB (Category::getDescriptionWithImages): non hanno
  // righe in attachment e le categorie sono visibili a tutti gli agenti.
  const inCategory = await executor
    .selectFrom("file as f")
    .innerJoin("faq_category as c", (j) => j.on("c.description", "like", `%cid:${key.replace(/_/g, "\\_")}%`))
    .select("f.id")
    .where("f.key", "=", key)
    .executeTakeFirst();
  return inCategory ? { fileId: inCategory.id, name: null } : null;
}

async function canSee(
  agent: Agent,
  ref: { type: string; object_id: number; thread_object_id: number | null; thread_object_type: string | null },
  executor: DbOrTx,
): Promise<boolean> {
  switch (ref.type) {
    case AttachmentType.THREAD_ENTRY: {
      if (!ref.thread_object_id) return false;
      // 'C' è trattato come ticket per compatibilità con la route precedente
      if (ref.thread_object_type === ObjectType.TICKET || ref.thread_object_type === ObjectType.CHILD_TICKET) {
        const ticket = await loadTicket(ref.thread_object_id, agent.id, executor);
        return !!ticket && (await checkStaffPerm(ticket, agent, undefined, executor));
      }
      if (ref.thread_object_type === ObjectType.TASK) {
        const task = await loadTask(ref.thread_object_id, executor);
        return !!task && checkTaskPerm(task, agent);
      }
      return false;
    }
    case AttachmentType.FAQ:
      return faqVisibleToAgent(agent, ref.object_id, executor);
    case AttachmentType.CANNED: {
      const canned = await executor
        .selectFrom("canned_response")
        .select(["dept_id", "isenabled"])
        .where("canned_id", "=", ref.object_id)
        .executeTakeFirst();
      return !!canned && cannedAccessible(agent, canned);
    }
    default:
      return false;
  }
}
