import "server-only";

import { loadConfigNamespace } from "../../config/config";
import { db } from "../../db";
import { detectDbTimezone } from "../../db/time";
import { buildTicketVars, companyVar } from "../../mail/objects";
import { VariableReplacer } from "../../mail/variables";
import type { Agent } from "../staff/staff";

/**
 * Risposta predefinita con le variabili del ticket (ajax.tickets.php cannedResponse):
 * Ticket::replaceVars($html, ['recipient' => proprietario]).
 */
export async function renderCannedForTicket(cannedId: number, ticketId: number, agent: Agent): Promise<string> {
  const executor = db();
  const canned = await executor
    .selectFrom("canned_response")
    .select(["response", "isenabled", "dept_id"])
    .where("canned_id", "=", cannedId)
    .executeTakeFirst();
  if (!canned || !canned.isenabled) return "";
  if (canned.dept_id && !agent.deptIds.includes(canned.dept_id)) return "";
  const cfg = await loadConfigNamespace("core", executor);
  const tv = await buildTicketVars(executor, ticketId, cfg, await detectDbTimezone(executor));
  if (!tv) return "";
  const r = new VariableReplacer().assign({
    ticket: tv.ticket,
    recipient: tv.ownerVar,
    url: cfg.str("helpdesk_url").replace(/\/+$/, ""),
    company: await companyVar(executor),
  });
  return r.replaceVars(canned.response);
}
