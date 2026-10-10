import { NextResponse } from "next/server";

import { currentClient, passwordChangePending, visitorKey } from "@/server/auth/client-auth";
import { loadConfigNamespace } from "@/server/config/config";
import { db } from "@/server/db";
import { portalOpenAllowed } from "@/server/domain/client/open";
import { signUploadToken, threadUploadRules, uploadFile } from "@/server/domain/file/upload";
import { readLimitedFormData } from "@/server/http/limited-form";

/**
 * Upload di un allegato dal portale clienti (FileUploadField::ajaxUpload lato cliente): stesso schema
 * di /api/agent/upload. Proprietario del token: `U<user_id>` per il cliente autenticato (anche
 * ospite da link), `G<chiave del visitatore>` per chi apre un ticket senza accesso (solo se il
 * portale consente l'apertura agli ospiti). Il file è salvato subito (file/file_chunk) e il form
 * invia il token firmato.
 */
export async function POST(request: Request) {
  const cfg = await loadConfigNamespace("core");
  const client = await currentClient();
  // cambio password obbligatorio in sospeso: niente upload, nemmeno come visitatore (client.inc.php)
  if (!client && (portalOpenAllowed(cfg, null) !== true || (await passwordChangePending()))) {
    return NextResponse.json({ error: "session_expired" }, { status: 403 });
  }
  const rules = threadUploadRules(cfg);
  if (!rules) return NextResponse.json({ error: "disabled" }, { status: 403 });

  // Limite di dimensione controllato prima di leggere tutto il corpo (anche senza login), poi sul file
  const body = await readLimitedFormData(request, rules.size);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.error === "size" ? 413 : 400 });
  const f = body.form.get("file");
  const file = f instanceof File ? f : null;
  if (!file) return NextResponse.json({ error: "invalid" }, { status: 400 });
  if (file.size > rules.size) return NextResponse.json({ error: "size" }, { status: 413 });

  const owner = client ? `U${client.id}` : `G${await visitorKey(true)}`;
  const data = Buffer.from(await file.arrayBuffer());
  const res = await uploadFile(db(), { name: file.name, type: file.type, data }, rules);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 422 });
  const { id, size, type } = res.file;
  return NextResponse.json({ id, name: res.name, size, type, token: signUploadToken(id, res.name, owner) });
}
