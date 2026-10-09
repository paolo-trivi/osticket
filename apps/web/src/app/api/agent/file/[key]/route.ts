import { NextResponse } from "next/server";

import { currentAgent } from "@/server/auth/staff-auth";
import { agentFileRef } from "@/server/domain/file/agent-access";
import { readStoredFile } from "@/server/domain/file/storage";

/**
 * Download di un file per agenti (equivalente di file.php con sessione staff).
 * Il file è identificato dalla sua chiave (file.key, usata anche nei riferimenti cid: del corpo) e
 * l'agente deve poter vedere almeno un oggetto a cui è allegato: voce di thread di un ticket o di un
 * task, FAQ, risposta predefinita (controlli in agentFileRef). Altrimenti 404, senza rivelare se il
 * file esiste.
 * Inline solo per immagini non SVG, come AttachmentFile::display (patch di sicurezza "Inline SVGs").
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const agent = await currentAgent();
  if (!agent) return new NextResponse(null, { status: 403 });
  const { key } = await params;

  const ref = await agentFileRef(agent, key);
  if (!ref) return new NextResponse(null, { status: 404 });

  const file = await readStoredFile(ref.fileId);
  if (!file) return new NextResponse(null, { status: 404 });

  const name = ref.name || file.name;
  const inlineOk = file.type.startsWith("image/") && !file.type.includes("svg");
  const disposition = new URL(request.url).searchParams.get("disposition") === "inline" && inlineOk ? "inline" : "attachment";
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": inlineOk ? file.type : "application/octet-stream",
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Content-Security-Policy": "default-src 'self'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
