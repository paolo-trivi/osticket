import { afterAll, describe, expect, it } from "vitest";

import { closeDb, db } from "@/server/db";
import { loadAgent } from "@/server/domain/staff/staff";
import { plotData, type ReportRange } from "@/server/domain/stats/report";

afterAll(closeDb);

const ALL: ReportRange = { start: "2000-01-01 00:00:00", stop: "2100-01-01 00:00:00" } as ReportRange;
const total = (p: Awaited<ReturnType<typeof plotData>>) => p.series.reduce((n, s) => n + s.data.reduce((a, b) => a + b, 0), 0);

describe("grafico della dashboard: solo i reparti dell'agente (differenza voluta dal PHP)", () => {
  it("conta gli eventi dei soli reparti accessibili", async () => {
    for (const id of [1, 3, 4]) {
      const agent = (await loadAgent(id, db()))!;
      const expected = await db()
        .selectFrom("thread_event")
        .select((eb) => eb.fn.count<number>("id").as("n"))
        .where("thread_type", "=", "T")
        .where("annulled", "=", 0)
        .where("dept_id", "in", agent.deptIds.length ? [...agent.deptIds] : [0])
        .executeTakeFirstOrThrow();
      expect(total(await plotData(ALL, agent))).toBe(Number(expected.n));
    }
  });
});
