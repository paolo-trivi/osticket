import "server-only";

import { db, type DbOrTx } from "../../db";

/**
 * Lettura dei file di osTicket (tabelle `file` + `file_chunk`).
 * Backend supportati: "D" = AttachmentChunkedData (contenuto nel DB, a blocchi ordinati per chunk_id).
 * Gli altri backend (es. "F" del plugin storage-fs) richiedono configurazione dedicata.
 */
interface StoredFile {
  id: number;
  name: string;
  type: string;
  size: number;
  data: Buffer;
}

export async function readStoredFile(fileId: number, executor: DbOrTx = db()): Promise<StoredFile | null> {
  if (!fileId) return null;
  const file = await executor
    .selectFrom("file")
    .select(["id", "name", "type", "size", "bk"])
    .where("id", "=", fileId)
    .executeTakeFirst();
  if (!file) return null;
  if ((file.bk || "D") !== "D") return null;

  const chunks = await executor
    .selectFrom("file_chunk")
    .select("filedata")
    .where("file_id", "=", fileId)
    .orderBy("chunk_id")
    .execute();
  return {
    id: file.id,
    name: file.name,
    type: file.type || "application/octet-stream",
    size: Number(file.size),
    data: Buffer.concat(chunks.map((c) => c.filedata)),
  };
}
