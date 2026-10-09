/**
 * La board calcola i permessi di trascinamento senza query (src/server/domain/board/grouping.ts, modulo puro usato
 * anche dai componenti client). Regola: quella del menu "Cambia stato" della vista ticket (TicketActionsMenu:
 * canStatus = roleOn(ticket, agent).perms.has(TicketPerm.CLOSE)); l'autorità resta changeTicketStatus.
 * Il test garantisce che le due regole non divergano per ogni agente attivo e ogni ticket accessibile.
 */
import { afterAll, describe, expect, it } from "vitest";

const { closeDb, db } = await import("@/server/db");
const { loadAgent, TicketPerm } = await import("@/server/domain/staff/staff");
const { cardPermissions } = await import("@/server/domain/board/grouping");
const { checkStaffPerm, loadTicket, roleOn } = await import("@/server/domain/ticket/ticket");

afterAll(closeDb);

describe("board ↔ menu di cambio stato", () => {
  it("stesse regole di permesso per tutti gli agenti attivi e tutti i ticket accessibili", async () => {
    const staff = await db().selectFrom("staff").select("staff_id").where("isactive", "=", 1).execute();
    const tickets = await db().selectFrom("ticket").select("ticket_id").execute();
    let compared = 0;
    for (const { staff_id } of staff) {
      const agent = await loadAgent(staff_id);
      if (!agent) continue;
      for (const { ticket_id } of tickets) {
        const t = await loadTicket(ticket_id, agent.id);
        if (!t || !(await checkStaffPerm(t, agent))) continue;
        const board = cardPermissions(agent, {
          deptId: t.dept_id,
          staffId: t.staff_id,
          teamId: t.team_id,
          state: t.status_state === "open" ? "open" : "closed",
        });
        const menu = roleOn(t, agent).perms.has(TicketPerm.CLOSE);
        expect({ ticket_id, staff_id, allowed: board.canClose }).toEqual({ ticket_id, staff_id, allowed: menu });
        expect(board.canReopen).toBe(menu);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(100);
  }, 120_000);
});
