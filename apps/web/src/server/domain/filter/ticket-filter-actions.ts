import "server-only";

import type { DbOrTx } from "../../db";
import { str, type PhpVal } from "../../php/values";
import { filterMatches, TicketRejected, type FilterAction, type TicketFilterRow, type TicketVars } from "./ticket-filter";

/**
 * Azioni dei filtri sui ticket in ingresso (include/class.filter_action.php): applicazione delle azioni
 * pre-creazione (reject, noresp, canned, dept, pri, sla, team, agent, topic, status) e post-creazione
 * (email) dei filtri corrispondenti, descrizioni degli eventi "edited" registrati dopo la creazione.
 */

interface ActiveDept {
  isActive: (id: number) => Promise<boolean>;
  topicIsActive: (id: number) => Promise<boolean>;
}

/**
 * Filter::apply per i filtri corrispondenti (in ordine, stop_onmatch): prima della creazione tutte le
 * azioni tranne `email`, dopo la creazione solo `email`. Restituisce i filtri applicati.
 */
export async function applyFilterActions(
  filters: TicketFilterRow[],
  what: TicketVars,
  vars: TicketVars,
  postCreate: boolean,
  checks: ActiveDept,
  sendEmail?: (action: FilterAction, filter: TicketFilterRow) => Promise<void>,
): Promise<TicketFilterRow[]> {
  const matched = filters.filter((f) => filterMatches(f, what));
  const applied: TicketFilterRow[] = [];
  for (const f of matched) {
    applied.push(f);
    for (const a of f.actions) {
      if ((a.type === "email") !== postCreate) continue;
      const c = a.config;
      switch (a.type) {
        case "reject":
          throw new TicketRejected(f.name, str(vars.email as PhpVal));
        case "noresp":
          vars.autorespond = false;
          break;
        case "canned":
          if (c.canned_id) vars.cannedResponseId = c.canned_id;
          break;
        case "dept":
          if (c.dept_id && (await checks.isActive(Number(c.dept_id)))) vars.deptId = c.dept_id;
          break;
        case "pri":
          if (c.priority) vars.priorityId = c.priority;
          break;
        case "sla":
          if (c.sla_id) vars.slaId = c.sla_id;
          break;
        case "team":
          if (c.team_id) vars.teamId = c.team_id;
          break;
        case "agent":
          if (c.staff_id) vars.staffId = c.staff_id;
          break;
        case "topic":
          if (c.topic_id && (await checks.topicIsActive(Number(c.topic_id)))) vars.topicId = c.topic_id;
          break;
        case "status":
          if (c.status_id) vars.statusId = c.status_id;
          break;
        case "email":
          if (sendEmail) await sendEmail(a, f);
          break;
        // replyto: solo per i ticket da email (Reply-To), gestiti dal PHP
      }
    }
    if (f.stopOnMatch) break;
  }
  return applied;
}

/** TriggerAction::getEventDescription per le azioni con descrizione (evento "edited") */
export async function actionEventData(executor: DbOrTx, a: FilterAction, filterName: string): Promise<Record<string, unknown> | null> {
  const c = a.config;
  const desc = (value: unknown, type: string) => ({ value, filter: filterName, type });
  switch (a.type) {
    case "dept": {
      if (!c.dept_id) return null;
      const d = await executor.selectFrom("department").select("name").where("id", "=", Number(c.dept_id)).executeTakeFirst();
      return desc(d ? d.name : false, "Department");
    }
    case "pri": {
      if (!c.priority) return null;
      const p = await executor.selectFrom("ticket_priority").select("priority_desc").where("priority_id", "=", Number(c.priority)).executeTakeFirst();
      return desc(p ? p.priority_desc : false, "Priority");
    }
    case "sla": {
      if (!c.sla_id) return null;
      const s = await executor.selectFrom("sla").select("name").where("id", "=", Number(c.sla_id)).executeTakeFirst();
      return desc(s ? s.name : false, "SLA");
    }
    case "team": {
      if (!c.team_id) return null;
      const t = await executor.selectFrom("team").select("name").where("team_id", "=", Number(c.team_id)).executeTakeFirst();
      return desc(t ? t.name : false, "Team");
    }
    case "agent": {
      if (!c.staff_id) return null;
      const s = await executor.selectFrom("staff").select(["firstname", "lastname"]).where("staff_id", "=", Number(c.staff_id)).executeTakeFirst();
      // getName()->name: nome completo "Nome Cognome"
      return desc(s ? `${s.firstname ?? ""} ${s.lastname ?? ""}`.trim() : false, "Agent");
    }
    case "topic": {
      if (!c.topic_id) return null;
      const t = await executor.selectFrom("help_topic").select("topic").where("topic_id", "=", Number(c.topic_id)).executeTakeFirst();
      return desc(t ? t.topic : false, "Topic");
    }
    case "status": {
      if (!c.status_id) return null;
      // Bug PHP replicato: FA_SetStatus cerca un Team con l'id dello stato
      const t = await executor.selectFrom("team").select("name").where("team_id", "=", Number(c.status_id)).executeTakeFirst();
      return desc(t ? t.name : false, "Ticket Status");
    }
  }
  return null;
}
