import "server-only";

import { NOW, type DbOrTx } from "../../db";
import type { ConfigNamespace } from "../../config/config";
import { phpJsonEncode } from "../../format/php-json";
import { bodySearchable, cleanEntryBody, sanitizeText, stripEmoticons, type BodyFormat } from "../../format/text";
import { attachFilesToEntry, type AttachInput } from "../file/upload";
import { replaceSearchRow } from "../search/index-writer";

/** Flag di ThreadEntry (include/class.thread.php). */
export const EntryFlag = {
  ORIGINAL_MESSAGE: 0x0001,
  EDITED: 0x0002,
  HIDDEN: 0x0004,
  GUARDED: 0x0008,
  RESENT: 0x0010,
  COLLABORATOR: 0x0020,
  BALANCED: 0x0040,
  SYSTEM: 0x0080,
  REPLY_ALL: 0x0100,
  REPLY_USER: 0x0200,
  CHILD: 0x0400,
} as const;

/** Destinatari come MailingList::getEmailAddresses(): {to|cc|bcc: {id: "Nome <email>"}} */
export type EntryRecipients = Partial<Record<"to" | "cc" | "bcc", Record<string, string>>>;

export interface NewThreadEntry {
  threadId: number;
  type: "M" | "R" | "N";
  body: string;
  format: BodyFormat;
  title?: string | null;
  staffId: number;
  userId: number;
  poster: string;
  source?: string;
  pid?: number;
  ip?: string;
  flags?: number;
  recipients?: EntryRecipients;
  /** editor_spacing del corpo HTML ($thisstaff || $thisclient); default: autore agente o utente */
  editorSpacing?: boolean;
  /** allegati già caricati (ThreadEntry::createAttachments, righe attachment di tipo H) */
  files?: AttachInput[];
}

export interface CreatedEntry {
  id: number;
  body: string;
  title: string | null;
  format: BodyFormat;
  flags: number;
}

/**
 * ThreadEntry::create (include/class.thread.php:1640) senza allegati: stesse colonne, stessi flag,
 * stessa pulizia del corpo e del titolo, poi Signal threadentry.created → indice `_search`.
 */
export async function createThreadEntry(tx: DbOrTx, cfg: ConfigNamespace, e: NewThreadEntry): Promise<CreatedEntry> {
  const body = cleanEntryBody(e.body, e.format, {
    allowExternalImages: cfg.bool("allow_external_images"),
    byUser: e.editorSpacing ?? (e.staffId > 0 || e.userId > 0),
  });
  const titleClean = e.title ? stripEmoticons(sanitizeText(e.title, true)) : "";
  const title = titleClean || null;
  const poster = e.poster ? sanitizeText(e.poster) : "";

  let flags = e.flags ?? 0;
  let recipients: string | null = null;
  if (e.recipients && Object.keys(e.recipients).length) {
    const count = Object.values(e.recipients).reduce((n, list) => n + Object.keys(list ?? {}).length, 0);
    flags |= count > 1 ? EntryFlag.REPLY_ALL : EntryFlag.REPLY_USER;
    recipients = phpJsonEncode(e.recipients);
  }
  if (e.userId) {
    const collab = await tx
      .selectFrom("thread_collaborator")
      .select("id")
      .where("user_id", "=", e.userId)
      .where("thread_id", "=", e.threadId)
      .executeTakeFirst();
    if (collab) flags |= EntryFlag.COLLABORATOR;
  }
  if (e.format === "html") flags |= EntryFlag.BALANCED;
  if (!e.staffId && !e.userId) flags |= EntryFlag.SYSTEM;

  const res = await tx
    .insertInto("thread_entry")
    .values({
      created: NOW,
      updated: NOW,
      type: e.type,
      thread_id: e.threadId,
      title,
      format: e.format,
      staff_id: e.staffId,
      user_id: e.userId,
      poster,
      source: e.source ?? "",
      flags,
      recipients,
      pid: e.pid ?? 0,
      ip_address: e.ip ?? "",
      body,
    })
    .executeTakeFirstOrThrow();
  const id = Number(res.insertId);

  // MysqlSearchBackend: indicizza solo il contenuto scritto da una persona
  if (e.files?.length) await attachFilesToEntry(tx, id, e.files);

  if (e.userId || e.staffId) await replaceSearchRow(tx, "H", id, bodySearchable(body, e.format), title ?? "");

  return { id, body, title, format: e.format, flags };
}

/** Thread di un oggetto (T ticket, A task). */
export async function threadOf(tx: DbOrTx, objectType: "T" | "A", objectId: number) {
  return tx
    .selectFrom("thread")
    .selectAll()
    .where("object_type", "=", objectType)
    .where("object_id", "=", objectId)
    .executeTakeFirst();
}

/** Thread::getLastMessage: ultimo messaggio (tipo M) del thread, eventualmente filtrato. */
export async function lastMessage(tx: DbOrTx, threadId: number, opts: { emailOnly?: boolean; userId?: number } = {}) {
  let q = tx
    .selectFrom("thread_entry as e")
    .leftJoin("thread_entry_email as em", "em.thread_entry_id", "e.id")
    .select(["e.id", "e.user_id", "em.mid", "em.headers"])
    .where("e.thread_id", "=", threadId)
    .where("e.type", "=", "M");
  if (opts.emailOnly) q = q.where("e.source", "=", "Email").where("em.headers", "is not", null);
  if (opts.userId) q = q.where("e.user_id", "=", opts.userId);
  return q.orderBy("e.id", "desc").limit(1).executeTakeFirst();
}

export async function touchThread(tx: DbOrTx, threadId: number, column: "lastresponse" | "lastmessage"): Promise<void> {
  await tx.updateTable("thread").set({ [column]: NOW }).where("id", "=", threadId).execute();
}
