import "server-only";

import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { db, type DbOrTx } from "../../db";

/**
 * Lettura dei file di osTicket (tabelle `file` + `file_chunk`).
 * Backend supportati:
 * - "D" = AttachmentChunkedData (contenuto nel DB, a blocchi ordinati per chunk_id);
 * - "F" = FilesystemStorage del plugin storage-fs (osTicket-plugins, storage-fs/storage.php), letto
 *   da OST_ATTACHMENTS_DIR: la cartella `uploadpath` del plugin montata in sola lettura. Senza la
 *   cartella configurata i file "F" non sono leggibili (null, come gli altri backend).
 * Gli altri backend (es. S3 dei plugin, "6" di osTicket 1.6) restituiscono null.
 * TailTicket non scrive mai su filesystem: i nuovi file restano nel DB (bk "D", vedi upload.ts).
 */
interface StoredFile {
  id: number;
  name: string;
  type: string;
  size: number;
  data: Buffer;
}

/**
 * Chiave usata come nome di file: AttachmentFile::_getKeyAndHash produce base64 url-safe
 * (`=` tolto, `+`→`-`, `/`→`_`). Si accettano anche `.`, `=` e `+` di chiavi più vecchie, mai come
 * primo carattere il punto (niente "." o ".." come cartella), mai separatori di percorso.
 */
const KEY_RE = /^[\w=+-][\w.=+-]{0,127}$/;

/** Cartella degli allegati su filesystem (OST_ATTACHMENTS_DIR), o null se non configurata. */
export function attachmentsDir(): string | null {
  const dir = (process.env.OST_ATTACHMENTS_DIR ?? "").trim();
  return dir ? dir : null;
}

/**
 * FilesystemStorage::getPath($hash) del plugin storage-fs: `<uploadpath>/<prima lettera della
 * chiave>/<chiave>`, con la chiave del file (`file.key`). Il percorso deve restare dentro la cartella
 * base: la chiave viene dal DB ma si valida comunque (path traversal). Null se non valido.
 */
export function fsStoragePath(baseDir: string, key: string): string | null {
  if (!baseDir || !KEY_RE.test(key)) return null;
  const base = path.resolve(baseDir);
  const full = path.resolve(base, key[0], key);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return full.startsWith(prefix) && path.dirname(path.dirname(full)) === base ? full : null;
}

/** Percorso reale di un file "F" leggibile (anche i link simbolici devono restare nella cartella). */
async function resolveFsFile(key: string): Promise<string | null> {
  const dir = attachmentsDir();
  const file = dir ? fsStoragePath(dir, key) : null;
  if (!dir || !file) return null;
  try {
    const [realBase, real] = await Promise.all([realpath(dir), realpath(file)]);
    if (!real.startsWith(realBase.endsWith(path.sep) ? realBase : realBase + path.sep)) return null;
    if (!(await stat(real)).isFile()) return null;
    await access(real, constants.R_OK);
    return real;
  } catch {
    return null;
  }
}

/** Backend del file: bk vuoto o NULL vale "D" (come la lettura storica di TailTicket). */
const backendOf = (bk: string | null | undefined) => bk || "D";

/**
 * TailTicket sa leggere il contenuto del file? "D" sempre, "F" solo con la cartella montata e il
 * file presente e leggibile, gli altri backend mai.
 */
export async function isStoredFileReadable(file: { bk: string | null; key: string }): Promise<boolean> {
  const bk = backendOf(file.bk);
  if (bk === "D") return true;
  if (bk === "F") return (await resolveFsFile(file.key)) !== null;
  return false;
}

export async function readStoredFile(fileId: number, executor: DbOrTx = db()): Promise<StoredFile | null> {
  if (!fileId) return null;
  const file = await executor.selectFrom("file").select(["id", "name", "type", "size", "bk", "key"]).where("id", "=", fileId).executeTakeFirst();
  if (!file) return null;
  const bk = backendOf(file.bk);
  let data: Buffer;
  if (bk === "D") {
    const chunks = await executor.selectFrom("file_chunk").select("filedata").where("file_id", "=", fileId).orderBy("chunk_id").execute();
    data = Buffer.concat(chunks.map((c) => c.filedata));
  } else if (bk === "F") {
    // FilesystemStorage::read/passthru: il file intero; un errore di lettura = file non disponibile
    const real = await resolveFsFile(file.key);
    if (!real) return null;
    try {
      data = await readFile(real);
    } catch {
      return null;
    }
  } else return null;
  return {
    id: file.id,
    name: file.name,
    type: file.type || "application/octet-stream",
    size: Number(file.size),
    data,
  };
}

/** File già segnalati come non leggibili (un avviso per file, la memoria resta limitata). */
const warned = new Set<number>();

/**
 * Avviso su console (mai in syslog: TailTicket non deve scrivere nel DB per un problema di lettura)
 * per un file non leggibile, una sola volta per file.
 */
export function warnUnreadableFile(fileId: number, name: string, context: string): void {
  if (warned.has(fileId)) return;
  if (warned.size >= 1000) warned.clear();
  warned.add(fileId);
  console.warn(`[file] ${context}: contenuto del file #${fileId} (${name}) non leggibile (backend non disponibile o file mancante)`);
}
