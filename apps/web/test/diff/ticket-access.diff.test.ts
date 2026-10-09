import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, db } from "@/server/db";
import { detectDbTimezone } from "@/server/db/time";
import { findStaffIdForLogin, loadAgent, TaskPerm, TicketPerm } from "@/server/domain/staff/staff";
import { checkStaffPerm, loadTicket } from "@/server/domain/ticket/ticket";

import { prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";

/** Ticket::checkStaffPerm: accesso e permessi di ruolo identici al PHP per ogni agente e ticket. */
const AGENTS = ["devadmin", "mrossi", "lbianchi", "gverdi", "aesposito"];
const PERMS = [...Object.values(TicketPerm), TaskPerm.CREATE];

beforeAll(async () => {
  await prepareSnapshot();
  await resetWorkingDatabases();
  await detectDbTimezone(db());
}, 300_000);
afterAll(closeDb);

describe("accesso ai ticket: PHP vs TypeScript", () => {
  for (const username of AGENTS) {
    it(`permessi di ${username} su tutti i ticket`, async () => {
      const php = await runPhp<{ access: Record<string, Record<string, boolean>> }>({
        op: "ticket.access",
        args: { agent: username, perms: PERMS },
      });
      const agent = (await loadAgent((await findStaffIdForLogin(username))!))!;
      const ts: Record<string, Record<string, boolean>> = {};
      for (const id of Object.keys(php.access)) {
        const ticket = (await loadTicket(Number(id), agent.id))!;
        const row: Record<string, boolean> = { view: await checkStaffPerm(ticket, agent) };
        for (const p of PERMS) row[p] = await checkStaffPerm(ticket, agent, p);
        ts[id] = row;
      }
      expect(ts).toEqual(php.access);
    });
  }
});
