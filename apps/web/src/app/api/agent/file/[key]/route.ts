import { NextResponse } from "next/server";

import { currentAgent } from "@/server/auth/staff-auth";
import { db } from "@/server/db";
import { readStoredFile } from "@/server/domain/file/storage";
import { checkStaffPerm, loadTicket } from "@/server/domain/ticket/ticket";

/**
 * Download di un allegato di thread per agenti (equivalente di file.php con sessione staff).
 * Il file è identificato dalla sua chiave (file.key, usata anche nei riferimenti cid: del corpo);
 * l'agente deve poter vedere il ticket a cui appartiene l'entry.
 * Inline solo per immagini non SVG, come AttachmentFile::display (patch di sicurezza "Inline SVGs").
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const agent = await currentAgent();
  if (!agent) return new NextResponse(null, { status: 403 });
  const { key } = await params;

  const ref = await db()
    .selectFrom("file as f")
    .innerJoin("attachment as a", "a.file_id", "f.id")
    .innerJoin("thread_entry as e", (j) => j.onRef("e.id", "=", "a.object_id").on("a.type", "=", "H"))
    .innerJoin("thread as th", "th.id", "e.thread_id")
    .select(["f.id as file_id", "a.name", "th.object_id", "th.object_type"])
    .where("f.key", "=", key)
    .executeTakeFirst();
  if (!ref || !["T", "C"].includes(ref.object_type)) return new NextResponse(null, { status: 404 });

  const ticket = await loadTicket(ref.object_id, agent.id);
  if (!ticket || !(await checkStaffPerm(ticket, agent))) return new NextResponse(null, { status: 404 });

  const file = await readStoredFile(ref.file_id);
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
