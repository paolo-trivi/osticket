import "server-only";

import { ThreadEntry } from "@/lib/osticket/flags";
import { ThreadEntryType } from "@/lib/osticket/object-types";

import { NOW, type DbOrTx } from "../../db";
import type { ConfigNamespace } from "../../config/config";
import { phpJsonEncode } from "../../format/php-json";
import { bodySearchable, cleanEntryBody, sanitizeText, stripEmoticons, type BodyFormat } from "../../format/text";
import { attachFilesToEntry, type AttachInput } from "../file/upload";
import { replaceSearchRow } from "../search/index-writer";

/**
 * Destinatari come MailingList::getEmailAddresses(): {to|cc|bcc: {id: "Nome <email>"}}. Una lista può
 * essere data come coppie [id, valore] per preservare l'ordine di inserimento del PHP (gli oggetti JS
 * ordinano le chiavi numeriche in modo crescente).
 */
export type RecipientList = Record<string, string> | Array<[string, string]>;
export type EntryRecipients = Partial<Record<"to" | "cc" | "bcc", RecipientList>>;

const recipientPairs = (l: RecipientList | undefined): Array<[string, string]> => (Array.isArray(l) ? l : Object.entries(l ?? {}));

/** json_encode dei destinatari con l'ordine delle chiavi preservato */
function encodeRecipients(r: EntryRecipients): string {
  const obj = (pairs: Array<[string, string]>) =>
    pairs.length ? `{${pairs.map(([k, v]) => `${phpJsonEncode(String(k))}:${phpJsonEncode(v)}`).join(",")}}` : "[]";
  const groups = Object.entries(r).filter(([, l]) => l !== undefined) as Array<[string, RecipientList]>;
  return `{${groups.map(([k, l]) => `${phpJsonEncode(k)}:${obj(recipientPairs(l))}`).join(",")}}`;
}

interface NewThreadEntry {
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

interface CreatedEntry {
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
    const count = Object.values(e.recipients).reduce((n, list) => n + recipientPairs(list).length, 0);
    flags |= count > 1 ? ThreadEntry.REPLY_ALL : ThreadEntry.REPLY_USER;
    recipients = encodeRecipients(e.recipients);
  }
  if (e.userId) {
    const collab = await tx
      .selectFrom("thread_collaborator")
      .select("id")
      .where("user_id", "=", e.userId)
      .where("thread_id", "=", e.threadId)
      .executeTakeFirst();
    if (collab) flags |= ThreadEntry.COLLABORATOR;
  }
  if (e.format === "html") flags |= ThreadEntry.BALANCED;
  if (!e.staffId && !e.userId) flags |= ThreadEntry.SYSTEM;

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

/** Thread::getLastMessage: ultimo messaggio (tipo M) del thread, eventualmente filtrato. */
export async function lastMessage(tx: DbOrTx, threadId: number, opts: { emailOnly?: boolean; userId?: number } = {}) {
  let q = tx
    .selectFrom("thread_entry as e")
    .leftJoin("thread_entry_email as em", "em.thread_entry_id", "e.id")
    .select(["e.id", "e.user_id", "em.mid", "em.headers"])
    .where("e.thread_id", "=", threadId)
    .where("e.type", "=", ThreadEntryType.MESSAGE);
  if (opts.emailOnly) q = q.where("e.source", "=", "Email").where("em.headers", "is not", null);
  if (opts.userId) q = q.where("e.user_id", "=", opts.userId);
  return q.orderBy("e.id", "desc").limit(1).executeTakeFirst();
}

export async function touchThread(tx: DbOrTx, threadId: number, column: "lastresponse" | "lastmessage"): Promise<void> {
  await tx.updateTable("thread").set({ [column]: NOW }).where("id", "=", threadId).execute();
}
