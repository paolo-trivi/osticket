import { NextResponse } from "next/server";

import { currentClient } from "@/server/auth/client-auth";
import { coreConfig } from "@/server/config/config";
import { clientAttachment } from "@/server/domain/client/ticket-view";
import { kbEnabled, publicFaqFile } from "@/server/domain/client/kb";
import { readStoredFile } from "@/server/domain/file/storage";

/**
 * Download per il portale clienti (file.php lato cliente): allegati delle voci del thread visibili al
 * cliente (messaggi e risposte, mai le note interne) di un ticket a cui ha accesso, oppure allegati
 * di FAQ pubblicate se la knowledge base è attiva. Il file è identificato dalla chiave (file.key);
 * inline solo per immagini non SVG.
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!/^[\w-]{1,64}$/.test(key)) return new NextResponse(null, { status: 404 });
  const client = await currentClient();
  let ref: { fileId: number; name: string | null } | null = client ? await clientAttachment(client, key) : null;
  if (!ref && (await kbEnabled(await coreConfig(), client))) ref = await publicFaqFile(key);
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
