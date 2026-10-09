import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, db } from "@/server/db";
import { detectDbTimezone } from "@/server/db/time";
import { listQueueTickets, loadQueues, navigableQueues, orderKeyValues, queueCounts } from "@/server/domain/queue/engine";
import { findStaffIdForLogin, loadAgent } from "@/server/domain/staff/staff";

import { prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";

/**
 * Letture: per ogni agente e ogni coda, la lista dei ticket (ordine compreso) e i contatori
 * devono coincidere con quelli calcolati dal codice PHP originale su una copia identica del DB.
 */
const AGENTS = ["devadmin", "mrossi", "lbianchi", "gverdi", "aesposito"];
const SORTS: (string | undefined)[] = [undefined, "1", "10", "qs-6", "qs-2"];

beforeAll(async () => {
  await prepareSnapshot();
  await resetWorkingDatabases();
  await detectDbTimezone(db());
}, 300_000);
afterAll(closeDb);

async function agentContext(username: string) {
  const id = await findStaffIdForLogin(username);
  const agent = (await loadAgent(id!))!;
  return { agent, userTz: agent.row.timezone || "Europe/Rome" };
}

describe("code: PHP vs TypeScript", () => {
  for (const username of AGENTS) {
    it(`liste e contatori di tutte le code per ${username}`, async () => {
      const { agent, userTz } = await agentContext(username);
      const queues = navigableQueues(await loadQueues(), agent);
      const counts = await queueCounts(agent, queues, { userTz });
      const mismatches: string[] = [];
      for (const q of queues) {
        for (const sort of SORTS) {
          const php = await runPhp<{ ids: number[] }>({
            op: "queue.list",
            args: { agent: username, queue: q.id, sort, dir: 0, page: 1, pageSize: 200 },
          });
          const ts = await listQueueTickets(agent, q, { sort, dir: 0, page: 1, pageSize: 200 }, { userTz });
          // stesso insieme di ticket
          const a = [...php.ids].sort((x, y) => x - y).join(",");
          const b = [...ts.ids].sort((x, y) => x - y).join(",");
          if (a !== b) {
            mismatches.push(`coda ${q.id} sort ${sort ?? "default"}: insiemi diversi php=${a} ts=${b}`);
            continue;
          }
          // stesso ordine a meno dei pari merito: la sequenza delle chiavi di ordinamento coincide
          const keys = await orderKeyValues(q, { sort, dir: 0 }, ts.ids);
          const kp = php.ids.map((id) => keys.get(id)).join(" ; ");
          const kt = ts.ids.map((id) => keys.get(id)).join(" ; ");
          if (kp !== kt) mismatches.push(`coda ${q.id} sort ${sort ?? "default"}: ordine diverso`);
        }
        // Contatore: numero di ticket che il PHP mostra nella coda (il contatore PHP 1.18.4 ignora la
        // visibilità per un bug documentato in doc 14; la nuova app conta solo i ticket visibili)
        const all = await runPhp<{ ids: number[] }>({
          op: "queue.list",
          args: { agent: username, queue: q.id, page: 1, pageSize: 1000 },
        });
        const c = counts.get(q.id);
        if (c !== "-" && c !== all.ids.length) mismatches.push(`coda ${q.id}: contatore ts=${c} lista php=${all.ids.length}`);
      }
      expect(mismatches).toEqual([]);
    });
  }
});
