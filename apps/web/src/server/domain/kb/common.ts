import "server-only";

import { AttachmentType } from "@/lib/osticket/object-types";

import type { DbOrTx } from "../../db";

/**
 * Parti comuni della knowledge base lato agente (FAQ, categorie, risposte predefinite): visibilità
 * e allegati degli oggetti KB.
 */

/** Category::VISIBILITY_* e FAQ::VISIBILITY_*: 0 interna/privata, 1 pubblica, 2 in evidenza */
export type KbVisibility = 0 | 1 | 2;
export const visibilityOf = (v: number | null | undefined): KbVisibility => (v === 1 || v === 2 ? v : 0);

// ---------------------------------------------------------------------------------------------
// Allegati di oggetti KB (attachment.type 'F' FAQ, 'C' risposta predefinita)

export interface KbAttachment {
  id: number;
  name: string;
  size: number;
  key: string;
  inline: boolean;
  lang: string | null;
}

type KbAttachmentType = typeof AttachmentType.FAQ | typeof AttachmentType.CANNED;

export async function objectAttachments(type: KbAttachmentType, objectId: number, executor: DbOrTx): Promise<KbAttachment[]> {
  const rows = await executor
    .selectFrom("attachment as a")
    .innerJoin("file as f", "f.id", "a.file_id")
    .select(["a.id", "a.name", "a.inline", "a.lang", "f.name as fname", "f.size", "f.key"])
    .where("a.type", "=", type)
    .where("a.object_id", "=", objectId)
    .orderBy("a.id")
    .execute();
  return rows.map((r) => ({ id: r.id, name: r.name || r.fname, size: Number(r.size), key: r.key, inline: !!r.inline, lang: r.lang }));
}
