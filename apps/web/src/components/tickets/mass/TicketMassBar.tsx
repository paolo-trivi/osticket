import { sql } from "kysely";

import { TicketStatus } from "@/lib/osticket/flags";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import type { TicketQueue } from "@/server/domain/queue/engine";
import { TicketPerm, type Agent } from "@/server/domain/staff/staff";
import { selectableDepts } from "@/server/domain/ticket/assign";
import { queueExportFields } from "@/server/domain/ticket/export";
import { ticketStatusChoices } from "@/server/domain/ticket/ticket-state";

import TicketMassActions from "./TicketMassActions";
import type { MassData } from "./types";

/**
 * Azioni di massa ed export della lista ticket (area "ticketedit"): permessi come
 * tickets-actions.tmpl.php (in almeno un ruolo) e status_options() con Staff::canManageTickets.
 */
export default async function TicketMassBar({ agent, queue, sort, dir }: { agent: Agent; queue: TicketQueue | null; sort?: string; dir?: string }) {
  const executor = db();
  const cfg = await coreConfig();
  const any = (p: string) => agent.hasPermInAnyRole(p);
  const can = {
    status: agent.canManageTickets(),
    assign: any(TicketPerm.ASSIGN),
    merge: any(TicketPerm.MERGE),
    link: any(TicketPerm.LINK),
    transfer: any(TicketPerm.TRANSFER),
    delete: any(TicketPerm.DELETE),
    export: !!queue?.id,
  };
  if (!Object.values(can).some(Boolean)) return null;
  const [choices, deleted, depts, internalClosed, exportFields] = await Promise.all([
    ticketStatusChoices(executor),
    executor.selectFrom("ticket_status").select(["id", "name", "state"]).where("state", "=", "deleted").where(sql<boolean>`(mode & ${sql.lit(TicketStatus.ENABLED)}) != 0`).orderBy("sort").execute(),
    can.transfer ? selectableDepts(executor, agent, null) : Promise.resolve([]),
    executor.selectFrom("ticket_status").select("id").where("state", "=", "closed").where(sql<boolean>`(mode & ${sql.lit(TicketStatus.INTERNAL)}) != 0`).orderBy("sort").execute(),
    queue?.id ? queueExportFields(executor, cfg, queue) : Promise.resolve([] as [string, string][]),
  ]);
  // TicketStatus::status_options(): stati aperti (con close o create), chiusi (close), eliminati (delete)
  const statuses = [
    ...choices.filter((s) => (s.state === "open" ? any(TicketPerm.CLOSE) || any(TicketPerm.CREATE) : any(TicketPerm.CLOSE))),
    ...(can.delete ? deleted.map((s) => ({ id: s.id, name: s.name, state: s.state ?? "deleted" })) : []),
  ];
  const data: MassData = {
    can,
    statuses,
    depts,
    closedStatuses: choices.filter((s) => s.state === "closed").map((s) => ({ id: s.id, name: s.name })),
    defaultChildStatusId: internalClosed[internalClosed.length - 1]?.id ?? 0,
    parentStatuses: choices.map((s) => ({ id: s.id, name: s.name })),
    queueId: queue?.id ?? 0,
    queueName: queue?.title ?? "",
    sort,
    dir,
    exportFields: exportFields.map(([path, label]) => ({ path, label })),
  };
  return <TicketMassActions data={data} />;
}
