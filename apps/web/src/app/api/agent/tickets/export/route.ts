import { NextResponse } from "next/server";

import { currentAgent } from "@/server/auth/staff-auth";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { loadQueues, navigableQueues } from "@/server/domain/queue/queues";
import { exportQueueCsv } from "@/server/domain/ticket/export";
import { agentTimeZone } from "@/server/format/datetime";

/**
 * Export CSV di una coda (ajax.php/tickets/export/<id> → CustomQueue::export):
 *   GET /api/agent/tickets/export?queue=<id>[&fields=<percorso>…][&delimiter=;][&sort=…&dir=…]
 * Solo code accessibili all'agente (CustomQueue::checkAccess). Il file è restituito subito (il PHP lo
 * prepara in background e, se non scaricato, lo invia per email).
 */
export async function GET(request: Request) {
  const agent = await currentAgent();
  if (!agent) return NextResponse.json({ error: "session_expired" }, { status: 403 });
  const url = new URL(request.url);
  const queueId = Number(url.searchParams.get("queue") ?? 0);
  const all = await loadQueues(db());
  const queue = all.get(queueId);
  // CustomQueue::checkAccess: code pubbliche o dell'agente
  if (!queue || !navigableQueues(all, agent).some((q) => q.id === queue.id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const fields = url.searchParams.getAll("fields").filter(Boolean);
  const delimiter = url.searchParams.get("delimiter") || ",";
  const sort = url.searchParams.get("sort") ?? undefined;
  const dir = url.searchParams.get("dir") === "1" ? 1 : 0;
  const cfg = await coreConfig();
  const { filename, content } = await exportQueueCsv(db(), cfg, agent, queue, {
    fields: fields.length ? fields : undefined,
    delimiter: [",", ";", "\t", "|"].includes(delimiter) ? delimiter : ",",
    sort,
    dir,
    userTz: await agentTimeZone(agent),
  });
  return new NextResponse(content, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
