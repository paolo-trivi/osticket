import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { sql } from "kysely";

import type { ConfigNamespace } from "../../config/config";
import { NOW, table, type DbOrTx } from "../../db";
import { installConfig } from "../../env";
import { sanitizeText } from "../../format/text";

/**
 * Scrittura dei file come AttachmentFile::create / ::upload (include/class.file.php) con il backend
 * "D" (AttachmentChunkedData, blocchi da 500 KiB in file_chunk) e collegamento alle voci del thread
 * (ThreadEntry::createAttachments → attachment di tipo H).
 */
export const CHUNK_SIZE = 500 * 1024;

export interface UploadInput {
  name: string;
  type: string;
  data: Buffer;
}

export interface StoredFileRef {
  id: number;
  name: string;
  key: string;
  type: string;
  size: number;
}

const urlSafe = (s: string) => s.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/** AttachmentFile::_getKeyAndHash: chiave (5 caratteri casuali dal prefisso microtime + sha1) e firma */
export function fileKeyAndHash(data: Buffer): { key: string; signature: string } {
  const sha1 = createHash("sha1").update(data).digest("base64");
  const md5 = createHash("md5").update(data).digest("base64");
  const prefix = createHash("sha1").update(`${process.hrtime.bigint()} ${randomBytes(8).toString("hex")}`).digest("base64");
  return { key: urlSafe(prefix.slice(0, 5) + sha1), signature: urlSafe(sha1.slice(0, 16) + md5.slice(0, 16)) };
}

/**
 * AttachmentFile::create($file, 'T', deduplicate=true): se esiste già un file con stessa firma e
 * dimensione si restituisce quello; altrimenti riga `file` + blocchi `file_chunk`, bk 'D', attrs NULL.
 */
export async function createAttachmentFile(executor: DbOrTx, input: UploadInput, ft = "T"): Promise<StoredFileRef> {
  const { key, signature } = fileKeyAndHash(input.data);
  const size = input.data.length;
  if (size > 0) {
    const existing = await executor
      .selectFrom("file")
      .select(["id", "name", "key", "type", "size"])
      .where("signature", "=", signature)
      .where("size", "=", size)
      .orderBy("id")
      .executeTakeFirst();
    if (existing) return { id: existing.id, name: existing.name, key: existing.key, type: existing.type, size: Number(existing.size) };
  }
  const type = (input.type || "application/octet-stream").toLowerCase();
  const res = await executor
    .insertInto("file")
    .values({ type, name: input.name, key, ft, signature, created: NOW, size })
    .executeTakeFirstOrThrow();
  const id = Number(res.insertId);
  for (let off = 0, chunk = 0; off < size; off += CHUNK_SIZE, chunk++) {
    await executor
      .insertInto("file_chunk")
      .values({ file_id: id, chunk_id: chunk, filedata: input.data.subarray(off, off + CHUNK_SIZE) })
      .execute();
  }
  await executor.updateTable("file").set({ bk: "D", attrs: null }).where("id", "=", id).execute();
  return { id, name: input.name, key, type, size };
}

/** Configurazione di upload di un campo (FileUploadField::getConfiguration) */
export interface UploadRules {
  /** dimensione massima in byte */
  size: number;
  /** estensioni ammesse ('.pdf'), vuoto = tutte */
  extensions: string[];
  /** tipi MIME ammessi esplicitamente */
  mimetypes: string[];
  /** numero massimo di file (0 = nessun limite) */
  max: number;
}

export function uploadRules(config: Record<string, unknown>, cfg: ConfigNamespace): UploadRules {
  const size = Number(config.size ?? cfg.int("max_file_size")) || cfg.int("max_file_size");
  let raw = typeof config.extensions === "string" ? config.extensions : "";
  if (raw.includes(".*")) raw = "";
  const extensions: string[] = [];
  const mimetypes: string[] = [];
  for (const part of raw.replace(/,/g, " ").split(/\s+/)) {
    if (!part) continue;
    if (part.indexOf("/") > 0) mimetypes.push(part);
    else extensions.push((part.startsWith(".") ? part : `.${part}`).toLowerCase());
  }
  return { size, extensions, mimetypes, max: Number(config.max) > 0 ? Number(config.max) : 0 };
}

/** FileUploadField::isValidFileType */
export function isAllowedFileType(rules: UploadRules, name: string, type: string): boolean {
  if (type && rules.mimetypes.includes(type)) return true;
  if (!rules.extensions.length || rules.extensions.includes(".*")) return true;
  const m = /\.([^./\\]+)$/.exec(name);
  const ext = m ? m[1].toLowerCase() : "";
  return !!ext && rules.extensions.includes(`.${ext}`);
}

/** FileUploadField::isValidFile: un file dichiarato immagine deve esserlo davvero (exif_imagetype) */
export function looksLikeImage(data: Buffer, type: string): boolean {
  if (!type.toLowerCase().startsWith("image/")) return true;
  const sig = (bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (sig([0x89, 0x50, 0x4e, 0x47]) || sig([0xff, 0xd8, 0xff]) || sig([0x47, 0x49, 0x46, 0x38]) || sig([0x42, 0x4d])) return true;
  if (sig([0x52, 0x49, 0x46, 0x46]) && data.subarray(8, 12).toString("latin1") === "WEBP") return true;
  if (sig([0x49, 0x49, 0x2a, 0x00]) || sig([0x4d, 0x4d, 0x00, 0x2a]) || sig([0x00, 0x00, 0x01, 0x00])) return true;
  return /<svg[\s>]/i.test(data.subarray(0, 2048).toString("utf8"));
}

export type UploadError = "invalid" | "type" | "size";

/**
 * FileUploadField::ajaxUpload: nome decodificato e sanificato (AttachmentFile::format), controllo del
 * file, del tipo e della dimensione, poi AttachmentFile::upload.
 */
export async function uploadFile(
  executor: DbOrTx,
  input: UploadInput,
  rules: UploadRules,
): Promise<{ ok: true; file: StoredFileRef; name: string } | { ok: false; error: UploadError }> {
  let name = input.name;
  try {
    name = decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    /* nome non codificato */
  }
  name = sanitizeText(name);
  if (!name || !looksLikeImage(input.data, input.type)) return { ok: false, error: "invalid" };
  if (!isAllowedFileType(rules, name, input.type)) return { ok: false, error: "type" };
  if (input.data.length > rules.size) return { ok: false, error: "size" };
  // `name` è il nome caricato (il file può essere uno già esistente con un altro nome, deduplicato)
  return { ok: true, file: await createAttachmentFile(executor, { ...input, name }), name };
}

export interface AttachInput {
  id: number;
  name?: string | null;
  inline?: boolean;
}

/**
 * ThreadEntry::createAttachments: righe `attachment` (type H). Il nome si registra solo se diverso
 * (strcasecmp) da quello del file; `inline` solo per immagini sicure. File deduplicati per chiave.
 */
export async function attachFilesToEntry(executor: DbOrTx, entryId: number, files: AttachInput[]): Promise<number[]> {
  const byKey = new Map<string, AttachInput & { fileName: string; type: string }>();
  for (const f of files) {
    const row = await executor.selectFrom("file").select(["id", "name", "key", "type"]).where("id", "=", f.id).executeTakeFirst();
    if (!row) continue;
    byKey.set(row.key, { ...f, fileName: row.name, type: row.type });
  }
  const ids: number[] = [];
  for (const f of byKey.values()) {
    const inline = !!f.inline && f.type.startsWith("image/") && !f.type.startsWith("image/svg");
    const name = f.name && f.name.toLowerCase() !== f.fileName.toLowerCase() ? f.name : null;
    const res = await sql`INSERT IGNORE INTO ${table("attachment")} (object_id, type, file_id, name, inline)
      VALUES (${entryId}, 'H', ${f.id}, ${name}, ${inline ? 1 : 0})`.execute(executor);
    if (res.numAffectedRows) ids.push(f.id);
  }
  return ids;
}

/** File allegati a una voce del thread, per le email (email_attachments) */
export async function entryAttachmentsForMail(executor: DbOrTx, entryId: number): Promise<{ filename: string; content: Buffer; contentType: string }[]> {
  const rows = await executor
    .selectFrom("attachment as a")
    .innerJoin("file as f", "f.id", "a.file_id")
    .select(["f.id", "f.name", "f.type", "a.name as aname", "a.inline"])
    .where("a.object_id", "=", entryId)
    .where("a.type", "=", "H")
    .orderBy("a.id")
    .execute();
  const out: { filename: string; content: Buffer; contentType: string }[] = [];
  for (const r of rows) {
    const chunks = await executor.selectFrom("file_chunk").select("filedata").where("file_id", "=", r.id).orderBy("chunk_id").execute();
    out.push({ filename: r.aname || r.name, content: Buffer.concat(chunks.map((c) => c.filedata)), contentType: r.type || "application/octet-stream" });
  }
  return out;
}

/**
 * Token di un file caricato, equivalente di $_SESSION[':uploadedFiles'] del PHP: un allegato può essere
 * collegato a una voce solo da chi lo ha caricato. Il token firma (HMAC con SECRET_SALT) id del file,
 * nome scelto e proprietario (es. "S<id agente>", "U<id utente>", "G<sessione ospite>") e scade dopo
 * `ttlSec`. Formato: `<id>.<scadenza>.<firma>.<nome url-encoded>`.
 */
export function signUploadToken(fileId: number, name: string, owner: string, ttlSec = 6 * 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return `${fileId}.${exp}.${uploadSig(fileId, exp, name, owner)}.${encodeURIComponent(name)}`;
}

function uploadSig(fileId: number, exp: number, name: string, owner: string): string {
  return createHmac("sha256", `upload:${installConfig().secretSalt}`).update(`${fileId}|${exp}|${owner}|${name}`).digest("base64url").slice(0, 32);
}

/** Verifica i token ricevuti dal form: restituisce gli allegati validi ({id, name}), ignora gli altri. */
export function verifyUploadTokens(tokens: string[], owner: string): AttachInput[] {
  const out: AttachInput[] = [];
  const seen = new Set<number>();
  for (const t of tokens) {
    const m = /^(\d+)\.(\d+)\.([\w-]{32})\.(.*)$/.exec(String(t));
    if (!m) continue;
    const id = Number(m[1]);
    const exp = Number(m[2]);
    let name: string;
    try {
      name = decodeURIComponent(m[4]);
    } catch {
      continue;
    }
    if (exp < Date.now() / 1000 || seen.has(id)) continue;
    const a = Buffer.from(m[3]);
    const b = Buffer.from(uploadSig(id, exp, name, owner));
    if (a.length !== b.length || !timingSafeEqual(a, b)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

/**
 * Regole di upload per gli allegati di un thread (ThreadEntryField / campo `attachments` delle
 * risposte): allow_attachments, max_file_size, allowed_filetypes della configurazione.
 */
export function threadUploadRules(cfg: ConfigNamespace): UploadRules | null {
  if (!cfg.bool("allow_attachments")) return null;
  return uploadRules({ size: cfg.int("max_file_size"), extensions: cfg.str("allowed_filetypes").trim() || undefined }, cfg);
}
