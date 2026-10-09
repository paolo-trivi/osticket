import { expect } from "vitest";

import { db } from "@/server/db";
import { loadAgent } from "@/server/domain/staff/staff";
import type { WriteContext } from "@/server/domain/ticket/context";
import { runWrite } from "@/server/domain/write";

import { compareWorkingDatabases, runPhp, type TableDiff } from "./harness";
import { mailsOf } from "./mailpit";

/** Helper comuni dei test differenziali dell'area "ticketedit". */
const IP = "127.0.0.1";

async function asAgent<T>(staffId: number, fn: (ctx: WriteContext) => Promise<T>): Promise<T> {
  const agent = await loadAgent(staffId, db());
  if (!agent) throw new Error("agente mancante");
  return runWrite({ agent, ip: IP }, fn);
}

type PhpResult = { ok?: boolean; error?: string | number; errors?: Record<string, unknown>; [k: string]: unknown };

/**
 * Datetime calcolati "adesso + ore SLA" (ticket.est_duedate): PHP e TS girano in istanti diversi e
 * possono cadere a cavallo di un secondo. Si tollera uno scarto fino a 2 s su quella sola colonna.
 */
function withoutDueDateDrift(diffs: TableDiff[]): TableDiff[] {
  const toMs = (v: unknown) => (typeof v === "string" ? Date.parse(v.replace(" ", "T") + "Z") : NaN);
  return diffs.filter((d) => {
    if (d.table !== "ticket" || d.onlyInPhp.length !== d.onlyInTs.length) return true;
    const byId = new Map(d.onlyInTs.map((r) => [r.ticket_id, r]));
    return !d.onlyInPhp.every((p) => {
      const t = byId.get(p.ticket_id);
      if (!t) return false;
      const { est_duedate: pd, ...pr } = p;
      const { est_duedate: td, ...tr } = t;
      return JSON.stringify(pr) === JSON.stringify(tr) && Math.abs(toMs(pd) - toMs(td)) <= 2000;
    });
  });
}

/** Esegue l'operazione PHP e poi quella TS; confronta DB ed email. */
export async function both<R = unknown>(op: string, args: Record<string, unknown>, ts: (ctx: WriteContext) => Promise<R>, mails = 0) {
  let php: PhpResult = {};
  const phpMails = await mailsOf(async () => {
    php = await runPhp<PhpResult>({ op, args });
  }, mails);
  let res: R | undefined;
  const tsMails = await mailsOf(async () => {
    res = await asAgent(Number(args.agent), ts);
  }, mails);
  expect(withoutDueDateDrift(await compareWorkingDatabases())).toEqual([]);
  expect(tsMails).toEqual(phpMails);
  expect(tsMails.length).toBe(mails);
  return { php, ts: res as R };
}
