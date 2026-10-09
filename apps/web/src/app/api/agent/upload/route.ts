import { NextResponse } from "next/server";

import { currentAgent } from "@/server/auth/staff-auth";
import { loadConfigNamespace } from "@/server/config/config";
import { db } from "@/server/db";
import { signUploadToken, threadUploadRules, uploadFile } from "@/server/domain/file/upload";

/**
 * Upload di un allegato per agenti (equivalente di ajax.php/form/upload/attach: FileUploadField::ajaxUpload
 * → AttachmentFile::upload): il file viene salvato subito (tabelle file/file_chunk, deduplicato per
 * firma e dimensione) e la risposta contiene un token firmato da inviare con il form, al posto di
 * $_SESSION[':uploadedFiles'].
 * Richiesta: multipart/form-data con il campo `file`. Risposta: {id, name, size, type, token} o {error}.
 */
export async function POST(request: Request) {
  const agent = await currentAgent();
  if (!agent) return NextResponse.json({ error: "session_expired" }, { status: 403 });
  const cfg = await loadConfigNamespace("core");
  const rules = threadUploadRules(cfg);
  if (!rules) return NextResponse.json({ error: "disabled" }, { status: 403 });

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get("file");
    file = f instanceof File ? f : null;
  } catch {
    file = null;
  }
  if (!file) return NextResponse.json({ error: "invalid" }, { status: 400 });
  // Limite di dimensione controllato prima di leggere tutto il contenuto
  if (file.size > rules.size) return NextResponse.json({ error: "size" }, { status: 413 });

  const data = Buffer.from(await file.arrayBuffer());
  const res = await uploadFile(db(), { name: file.name, type: file.type, data }, rules);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 422 });
  const { id, size, type } = res.file;
  return NextResponse.json({ id, name: res.name, size, type, token: signUploadToken(id, res.name, `S${agent.id}`) });
}
