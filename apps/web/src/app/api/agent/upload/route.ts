import { NextResponse } from "next/server";

import { currentAgent } from "@/server/auth/staff-auth";
import { loadConfigNamespace } from "@/server/config/config";
import { db } from "@/server/db";
import { signUploadToken, threadUploadRules, uploadFile } from "@/server/domain/file/upload";
import { readLimitedFormData } from "@/server/http/limited-form";
import { canWrite, isReadOnlyError, withWriteScope } from "@/server/system/write-mode";

/**
 * Upload di un allegato per agenti (equivalente di ajax.php/form/upload/attach: FileUploadField::ajaxUpload
 * → AttachmentFile::upload): il file viene salvato subito (tabelle file/file_chunk, deduplicato per
 * firma e dimensione) e la risposta contiene un token firmato da inviare con il form, al posto di
 * $_SESSION[':uploadedFiles'].
 * Richiesta: multipart/form-data con il campo `file`. Risposta: {id, name, size, type, token} o {error}.
 * Scrittura "operational" (write-mode.ts): se non consentita, 503 {error: "read_only"}.
 */
export async function POST(request: Request) {
  const agent = await currentAgent();
  if (!agent) return NextResponse.json({ error: "session_expired" }, { status: 403 });
  if (!(await canWrite("operational"))) return readOnly();
  const cfg = await loadConfigNamespace("core");
  const rules = threadUploadRules(cfg);
  if (!rules) return NextResponse.json({ error: "disabled" }, { status: 403 });

  // Limite di dimensione controllato prima di leggere tutto il corpo, poi sul file
  const body = await readLimitedFormData(request, rules.size);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.error === "size" ? 413 : 400 });
  const f = body.form.get("file");
  const file = f instanceof File ? f : null;
  if (!file) return NextResponse.json({ error: "invalid" }, { status: 400 });
  if (file.size > rules.size) return NextResponse.json({ error: "size" }, { status: 413 });

  const data = Buffer.from(await file.arrayBuffer());
  let res: Awaited<ReturnType<typeof uploadFile>>;
  try {
    res = await withWriteScope("operational", () => uploadFile(db(), { name: file.name, type: file.type, data }, rules), {
      op: "agent.upload",
      actor: { type: "agent", id: agent.id },
    });
  } catch (err) {
    if (isReadOnlyError(err)) return readOnly();
    throw err;
  }
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 422 });
  const { id, size, type } = res.file;
  return NextResponse.json({ id, name: res.name, size, type, token: signUploadToken(id, res.name, `S${agent.id}`) });
}

function readOnly() {
  return NextResponse.json({ error: "read_only" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
