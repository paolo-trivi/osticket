import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { TicketPerm, type Agent } from "@/server/domain/staff/staff";
import { deptIsMember, loadDept } from "@/server/domain/ticket/alerts";
import { activeTeams, assignableAgents, listReferrals, referralChoices, selectableDepts } from "@/server/domain/ticket/assign";
import { DeptFlag } from "@/server/domain/ticket/status";
import { menuStatuses } from "@/server/domain/ticket/ticket-state";
import { roleOn, type TicketDetail } from "@/server/domain/ticket/ticket";
import { PersonsName } from "@/server/format/persons-name";

import TicketActionsBar from "./actions/TicketActionsBar";
import type { TicketActionsData } from "./actions/types";

/**
 * Slot della vista ticket per assegnazione, presa in carico, rilascio, trasferimento, referral,
 * cambio stato, segna risposto/non risposto (area "actions"). Le voci seguono le condizioni di
 * include/staff/ticket-view.inc.php e templates/status-options.tmpl.php.
 */
export default async function TicketActionsMenu({ ticket, agent }: { ticket: TicketDetail; agent: Agent; locale: string }) {
  const executor = db();
  const cfg = await coreConfig();
  const nameFormat = cfg.str("agent_name_format");
  const role = roleOn(ticket, agent);
  const isOpen = ticket.status_state === "open";
  const dept = await loadDept(executor, ticket.dept_id);
  const isManager = !!dept?.manager_id && dept.manager_id === agent.id;

  const staff = ticket.staff_id
    ? await executor.selectFrom("staff").select(["staff_id", "firstname", "lastname"]).where("staff_id", "=", ticket.staff_id).executeTakeFirst()
    : undefined;
  const team = ticket.team_id ? await executor.selectFrom("team").select(["team_id", "name"]).where("team_id", "=", ticket.team_id).executeTakeFirst() : undefined;
  const isAssigned = isOpen && !!(ticket.staff_id || ticket.team_id);

  const canAssign = isOpen && role.perms.has(TicketPerm.ASSIGN);
  const canClaim =
    canAssign && !staff && (!dept || !(dept.flags & DeptFlag.ASSIGN_MEMBERS_ONLY) || (await deptIsMember(executor, dept, agent.id)));
  const canTransfer = role.perms.has(TicketPerm.TRANSFER);
  const canRelease = isAssigned && (isManager || role.perms.has(TicketPerm.RELEASE));
  const canMark = isOpen && (isManager || role.perms.has(TicketPerm.MARKANSWERED));
  // La voce "Referral" richiede PERM_REFER; l'endpoint PHP controlla PERM_ASSIGN: servono entrambi
  const canRefer = role.perms.has(TicketPerm.REFER) && role.perms.has(TicketPerm.ASSIGN);
  const canStatus = role.perms.has(TicketPerm.CLOSE);

  const [agents, teams, depts, referral, statuses, children, referrals] = await Promise.all([
    canAssign ? assignableAgents(executor, ticket.dept_id, agent, nameFormat) : Promise.resolve([]),
    canAssign ? activeTeams(executor) : Promise.resolve([]),
    canTransfer ? selectableDepts(executor, agent, ticket.dept_id) : Promise.resolve([]),
    canRefer ? referralChoices(executor, ticket.dept_id, agent, nameFormat) : Promise.resolve(null),
    canStatus ? menuStatuses({ tx: executor }, ticket.status_id) : Promise.resolve([]),
    executor.selectFrom("ticket").select("ticket_id").where("ticket_pid", "=", ticket.ticket_id).execute(),
    canRefer && ticket.thread_id ? listReferrals(executor, ticket.thread_id) : Promise.resolve([]),
  ]);

  // Nomi dei referral esistenti
  const names = new Map<string, string>();
  if (referrals.length) {
    const ids = (type: string) => referrals.filter((r) => r.object_type === type).map((r) => r.object_id);
    const [s, tm, d] = await Promise.all([
      ids("S").length ? executor.selectFrom("staff").select(["staff_id", "firstname", "lastname"]).where("staff_id", "in", ids("S")).execute() : [],
      ids("E").length ? executor.selectFrom("team").select(["team_id", "name"]).where("team_id", "in", ids("E")).execute() : [],
      ids("D").length ? executor.selectFrom("department").select(["id", "name"]).where("id", "in", ids("D")).execute() : [],
    ]);
    for (const r of s) names.set(`S${r.staff_id}`, new PersonsName({ first: r.firstname ?? "", last: r.lastname ?? "" }, nameFormat).toString());
    for (const r of tm) names.set(`E${r.team_id}`, r.name);
    for (const r of d) names.set(`D${r.id}`, r.name ?? "");
  }

  const data: TicketActionsData = {
    ticketId: ticket.ticket_id,
    number: ticket.number,
    isAssigned,
    isAnswered: !!ticket.isanswered,
    assignedStaff: staff ? { id: staff.staff_id, name: new PersonsName({ first: staff.firstname ?? "", last: staff.lastname ?? "" }, nameFormat).toString(), isMe: staff.staff_id === agent.id } : null,
    assignedTeam: team ? { id: team.team_id, name: team.name } : null,
    deptId: ticket.dept_id,
    can: { assign: canAssign, claim: canClaim, transfer: canTransfer, release: canRelease, mark: canMark, refer: canRefer, status: canStatus },
    agents,
    teams,
    depts,
    referral: referral ?? { agents: [], teams: [], depts: [] },
    referrals: referrals.map((r) => ({ id: r.id, type: r.object_type as "S" | "E" | "D", name: names.get(`${r.object_type}${r.object_id}`) ?? `#${r.object_id}` })),
    statuses,
    hasChildren: !!(ticket.flags & 0x10) && children.length > 0,
  };

  if (!Object.values(data.can).some(Boolean)) return null;
  return <TicketActionsBar data={data} />;
}
