import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db } from "@/server/db";
import { coreConfig } from "@/server/config/config";
import { loadQueues, orderKeyValues } from "@/server/domain/queue/engine";
import { loadAgent } from "@/server/domain/staff/staff";
import { exportQueueCsv } from "@/server/domain/ticket/export";

import { execBoth, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";

/**
 * Export CSV delle code (CustomQueue::export): intestazioni e righe identiche al PHP, sui DB di lavoro
 * (stessi dati per PHP e TS).
 */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

async function compare(agentId: number, queueId: number, fields?: string[], delimiter = ",") {
  const php = await runPhp<{ ok: boolean; csv: string }>({ op: "ticketedit.export", args: { agent: agentId, queue: queueId, fields, delimiter } });
  expect(php.ok).toBe(true);
  const phpCsv = Buffer.from(php.csv, "base64").toString("utf8");
  const agent = (await loadAgent(agentId, db()))!;
  const queue = (await loadQueues(db())).get(queueId)!;
  const cfg = await coreConfig();
  const ts = await exportQueueCsv(db(), cfg, agent, queue, { fields, delimiter, userTz: "UTC" });
  const tsLines = ts.content.split("\n");
  const phpLines = phpCsv.split("\n");
  // Intestazioni identiche; righe identiche come insieme
  expect(tsLines[0]).toEqual(phpLines[0]);
  expect([...tsLines].sort()).toEqual([...phpLines].sort());
  // Ordine: stessa sequenza di chiavi di ordinamento (i pari merito possono uscire in ordine diverso,
  // come tra due esecuzioni di MySQL); la prima colonna è il numero del ticket
  const numbers = (lines: string[]) => lines.slice(1).filter(Boolean).map((l) => l.split(delimiter)[0]);
  const rows = await db().selectFrom("ticket").select(["ticket_id", "number"]).execute();
  const idOf = new Map(rows.map((r) => [r.number, r.ticket_id]));
  const keys = await orderKeyValues(queue, {}, rows.map((r) => r.ticket_id));
  const seq = (lines: string[]) => numbers(lines).map((n) => keys.get(idOf.get(n)!));
  expect(seq(tsLines)).toEqual(seq(phpLines));
  return phpCsv;
}

describe("export CSV delle code", () => {
  it("coda Open (admin), campi standard", async () => {
    const csv = await compare(1, 1);
    expect(csv.split("\n").length).toBeGreaterThan(10);
  });

  it("coda Closed vista da un agente con visibilità limitata", async () => {
    await compare(3, 8);
  });

  it("sottocoda Overdue, con allegati, task, riaperture, merge e collaboratori", async () => {
    await execBoth(
      "INSERT INTO {p}attachment (object_id, type, file_id, name, inline, lang) VALUES (7, 'H', 2, NULL, 0, NULL), (7, 'H', 1, NULL, 1, NULL)",
      "UPDATE {p}ticket SET flags = 0x11 WHERE ticket_id = 4",
      "UPDATE {p}ticket SET ticket_pid = 4, flags = 0x1 WHERE ticket_id = 10",
    );
    await compare(1, 4);
    await compare(1, 1);
  });

  it("campi scelti e separatore punto e virgola", async () => {
    await compare(2, 1, ["number", "cdata__subject", "staff_id", "isanswered", "task_count"], ";");
  });
});
