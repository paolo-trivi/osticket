import { CompiledQuery, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, sql, type DatabaseConnection, type Driver, type QueryResult } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";

import type { DB } from "@/server/db/schema.gen";
import { clearTableKeysForTests } from "@/server/db/table-keys";
import { TablePrefixPlugin } from "@/server/db/table-prefix-plugin";
import { withWriteGate } from "@/server/db/write-gate";
import { ChangeRecorder, runWithRecorder } from "@/server/system/changes/recorder";
import { applyRestoreOp } from "@/server/system/changes/restore";
import { ReadOnlyModeError, withWriteScope, type WriteMode } from "@/server/system/write-mode";

/**
 * Cattura delle righe nel gate delle scritture (row-capture.ts) con un driver finto: risponde alle query
 * secondo uno "script" (chiavi da information_schema, righe prima/dopo) e registra il testo SQL.
 */
type Row = Record<string, unknown>;
type Reply = (q: CompiledQuery) => QueryResult<Row> | undefined;

/** Chiavi delle tabelle finte: PRIMARY e indici univoci, colonne con EXTRA. */
const KEYS: Record<string, { idx: [string, string][]; cols: [string, string][] }> = {
  ost_staff: {
    idx: [
      ["PRIMARY", "staff_id"],
      ["username", "username"],
    ],
    cols: [
      ["staff_id", "auto_increment"],
      ["isactive", ""],
      ["username", ""],
    ],
  },
  ost_config: {
    idx: [
      ["PRIMARY", "id"],
      ["namespace", "namespace"],
      ["namespace", "key"],
    ],
    cols: [
      ["id", "auto_increment"],
      ["namespace", ""],
      ["key", ""],
      ["value", ""],
      ["updated", ""],
    ],
  },
  ost_staff_dept_access: {
    idx: [
      ["PRIMARY", "staff_id"],
      ["PRIMARY", "dept_id"],
    ],
    cols: [
      ["staff_id", ""],
      ["dept_id", ""],
      ["role_id", ""],
    ],
  },
  ost_help_topic: {
    idx: [["PRIMARY", "topic_id"]],
    cols: [
      ["topic_id", "auto_increment"],
      ["sort", ""],
      ["topic", ""],
    ],
  },
  ost_syslog: { idx: [["PRIMARY", "log_id"]], cols: [["log_id", "auto_increment"]] },
};

function keysReply(q: CompiledQuery): QueryResult<Row> | undefined {
  const t = KEYS[String(q.parameters[0])];
  if (q.sql.includes("information_schema.STATISTICS")) return { rows: (t?.idx ?? []).map(([idx, col]) => ({ idx, col })) };
  if (q.sql.includes("information_schema.COLUMNS")) return { rows: (t?.cols ?? []).map(([col, extra]) => ({ col, extra })) };
  return undefined;
}

class ScriptDriver implements Driver {
  executed: string[] = [];
  reply: Reply = () => undefined;
  async init() {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return {
      executeQuery: async <R>(q: CompiledQuery): Promise<QueryResult<R>> => {
        this.executed.push(q.sql);
        return (keysReply(q) ?? this.reply(q) ?? { rows: [] }) as QueryResult<R>;
      },
      async *streamQuery() {
        throw new Error("non usato");
      },
    };
  }
  async beginTransaction() {
    this.executed.push("begin");
  }
  async commitTransaction() {
    this.executed.push("commit");
  }
  async rollbackTransaction() {
    this.executed.push("rollback");
  }
  async releaseConnection() {}
  async destroy() {}
}

let driver: ScriptDriver;
let k: Kysely<DB>;
let mode: WriteMode | null;
let restore: boolean;

beforeEach(() => {
  clearTableKeysForTests();
  driver = new ScriptDriver();
  mode = "full";
  restore = false;
  k = new Kysely<DB>({
    dialect: withWriteGate(
      {
        createAdapter: () => new MysqlAdapter(),
        createDriver: () => driver,
        createIntrospector: (d) => new MysqlIntrospector(d),
        createQueryCompiler: () => new MysqlQueryCompiler(),
      },
      { mode: async () => mode, restore: async () => restore, completed: () => {}, collect: () => false },
    ),
    plugins: [new TablePrefixPlugin("ost_")],
  });
});

/** Esegue fn come modifica admin e restituisce il recorder. */
async function capture(fn: () => Promise<unknown>, rec = new ChangeRecorder((t) => t === "ost_syslog")): Promise<ChangeRecorder> {
  await withWriteScope("admin", () => runWithRecorder(rec, fn)).catch((err) => {
    if (!(err instanceof Error && err.message === "rollback voluto")) throw err;
  });
  return rec;
}

describe("cattura delle righe: UPDATE e DELETE", () => {
  it("UPDATE: SELECT … FOR UPDATE con lo stesso WHERE, rilettura per chiave, solo le colonne cambiate", async () => {
    driver.reply = (q) => {
      if (/^select `staff_id`, `isactive` from `ost_staff` where `dept_id` = \? limit 5001 for update$/.test(q.sql)) {
        return {
          rows: [
            { staff_id: 1, isactive: 1 },
            { staff_id: 2, isactive: 0 },
          ],
        };
      }
      if (q.sql.startsWith("update")) return { rows: [], numAffectedRows: 2n };
      if (q.sql === "SELECT `staff_id`, `isactive` FROM `ost_staff` WHERE `staff_id` IN (?, ?)") {
        return {
          rows: [
            { staff_id: 1, isactive: 0 },
            { staff_id: 2, isactive: 0 },
          ],
        };
      }
    };
    const rec = await capture(() => k.transaction().execute((tx) => tx.updateTable("staff").set({ isactive: 0 }).where("dept_id", "=", 3).execute()));
    expect(rec.failure).toBeNull();
    expect(rec.entries).toEqual([{ table: "ost_staff", pk: { staff_id: 1 }, before: { isactive: 1 }, after: { isactive: 0 } }]);
    // la SELECT di cattura precede la scrittura, nella stessa transazione
    const i = driver.executed.findIndex((s) => s.startsWith("select `staff_id`"));
    expect(driver.executed.indexOf("begin")).toBeLessThan(i);
    expect(i).toBeLessThan(driver.executed.findIndex((s) => s.startsWith("update")));
  });

  it("DELETE: riga intera nel before-image; datetime, date zero, NULL e binari esatti", async () => {
    const row = { id: 7, namespace: "core", key: "x", value: null, updated: "0000-00-00 00:00:00", blob: Buffer.from([0, 255]) };
    driver.reply = (q) => {
      if (/^select \* from `ost_config` where `namespace` = \? limit 5001 for update$/.test(q.sql)) return { rows: [row] };
      if (q.sql.startsWith("delete")) return { rows: [], numAffectedRows: 1n };
    };
    const rec = await capture(() => k.deleteFrom("config").where("namespace", "=", "core").execute());
    expect(rec.entries).toEqual([
      { table: "ost_config", pk: { id: 7 }, before: { id: 7, namespace: "core", key: "x", value: null, updated: "0000-00-00 00:00:00", blob: { $b64: "AP8=" } }, after: null },
    ]);
  });

  it("rollback: le righe della transazione si scartano", async () => {
    driver.reply = (q) => (q.sql.startsWith("select *") ? { rows: [{ id: 1 }] } : q.sql.startsWith("delete") ? { rows: [], numAffectedRows: 1n } : undefined);
    const rec = await capture(() =>
      k.transaction().execute(async (tx) => {
        await tx.deleteFrom("config").where("id", "=", 1).execute();
        throw new Error("rollback voluto");
      }),
    );
    expect(driver.executed).toContain("rollback");
    expect(rec.entries).toEqual([]);
    expect(rec.failure).toBeNull();
  });

  it("oltre il limite di righe: modifica non annullabile (too_large), la scrittura avviene", async () => {
    driver.reply = (q) => (q.sql.startsWith("select *") ? { rows: Array.from({ length: 5001 }, (_, i) => ({ id: i + 1 })) } : undefined);
    const rec = await capture(() => k.deleteFrom("config").where("namespace", "=", "big").execute());
    expect(rec.failure?.reason).toBe("too_large");
    expect(rec.entries).toEqual([]);
    expect(driver.executed.some((s) => s.startsWith("delete from `ost_config`"))).toBe(true);
  });

  it("SQL scritto a mano e LIMIT senza ORDER BY: non annullabile, scrittura comunque eseguita", async () => {
    const raw = await capture(() => sql`UPDATE ${sql.table("ost_staff")} SET isactive = 0`.execute(k));
    expect(raw.failure).toMatchObject({ reason: "raw_sql" });
    expect(driver.executed.at(-1)).toBe("UPDATE `ost_staff` SET isactive = 0");
    const limited = await capture(() => k.deleteFrom("config").where("namespace", "=", "x").limit(1).execute());
    expect(limited.failure?.reason).toBe("limit_without_order");
  });
});

describe("cattura delle righe: INSERT", () => {
  it("AUTO_INCREMENT: righe rilette dall'insertId e verificate", async () => {
    driver.reply = (q) => {
      if (q.sql.startsWith("insert")) return { rows: [], insertId: 41n, numAffectedRows: 2n };
      if (q.sql.startsWith("SELECT * FROM `ost_config` WHERE `id` BETWEEN")) {
        expect(q.parameters).toEqual(["41", "42"]);
        return {
          rows: [
            { id: 41, namespace: "n", key: "a", value: "1", updated: "2026-10-10 10:00:00" },
            { id: 42, namespace: "n", key: "b", value: "2", updated: "2026-10-10 10:00:00" },
          ],
        };
      }
    };
    const rec = await capture(() =>
      k
        .insertInto("config")
        .values([
          { namespace: "n", key: "a", value: "1", updated: sql`NOW()` },
          { namespace: "n", key: "b", value: 2 as never, updated: sql`NOW()` },
        ])
        .execute(),
    );
    expect(rec.failure).toBeNull();
    expect(rec.entries.map((e) => [e.pk, e.before, e.after?.key])).toEqual([
      [{ id: 41 }, null, "a"],
      [{ id: 42 }, null, "b"],
    ]);
  });

  it("id non consecutivi (righe del range diverse da quelle inserite): non annullabile", async () => {
    driver.reply = (q) => {
      if (q.sql.startsWith("insert")) return { rows: [], insertId: 41n, numAffectedRows: 2n };
      if (q.sql.includes("BETWEEN"))
        return {
          rows: [
            { id: 41, namespace: "n", key: "a" },
            { id: 42, namespace: "altro", key: "z" },
          ],
        };
    };
    const rec = await capture(() =>
      k
        .insertInto("config")
        .values([
          { namespace: "n", key: "a", value: "" },
          { namespace: "n", key: "b", value: "" },
        ])
        .execute(),
    );
    expect(rec.failure?.reason).toBe("insert_mismatch");
  });

  it("chiave composta nei valori: righe rilette per chiave", async () => {
    driver.reply = (q) => (q.sql === "SELECT * FROM `ost_staff_dept_access` WHERE (`staff_id`, `dept_id`) IN ((?, ?))" ? { rows: [{ staff_id: 3, dept_id: 4, role_id: 1 }] } : undefined);
    const rec = await capture(() => k.insertInto("staff_dept_access").values({ staff_id: 3, dept_id: 4, role_id: 1, flags: 0 }).execute());
    expect(rec.entries).toEqual([{ table: "ost_staff_dept_access", pk: { staff_id: 3, dept_id: 4 }, before: null, after: { staff_id: 3, dept_id: 4, role_id: 1 } }]);
  });

  it("ON DUPLICATE KEY UPDATE: righe esistenti prima e dopo, voci di UPDATE con le sole colonne cambiate", async () => {
    let written = false;
    driver.reply = (q) => {
      if (q.sql.startsWith("insert")) {
        written = true;
        return { rows: [], numAffectedRows: 2n };
      }
      if (q.sql.startsWith("SELECT * FROM `ost_help_topic` WHERE `topic_id` IN (?, ?)")) {
        return {
          rows: [
            { topic_id: 1, sort: written ? 2 : 1, topic: "A" },
            { topic_id: 2, sort: written ? 1 : 2, topic: "B" },
          ],
        };
      }
    };
    const rec = await capture(() =>
      k
        .insertInto("help_topic")
        .values([
          { topic_id: 1, sort: 2 },
          { topic_id: 2, sort: 1 },
        ] as never)
        .onDuplicateKeyUpdate({ sort: sql`VALUES(\`sort\`)` } as never)
        .execute(),
    );
    expect(rec.entries).toEqual([
      { table: "ost_help_topic", pk: { topic_id: 1 }, before: { sort: 1 }, after: { sort: 2 } },
      { table: "ost_help_topic", pk: { topic_id: 2 }, before: { sort: 2 }, after: { sort: 1 } },
    ]);
    expect(driver.executed.find((s) => s.startsWith("SELECT * FROM `ost_help_topic`"))).toMatch(/FOR UPDATE$/);
  });

  it("INSERT nel syslog non registrato (log in sola aggiunta); nessuna lettura di cattura", async () => {
    const rec = await capture(() =>
      k
        .insertInto("syslog")
        .values({ title: "t", log_type: "Debug", log: "", ip_address: "", logger: "" } as never)
        .execute(),
    );
    expect(rec.entries).toEqual([]);
    expect(rec.failure).toBeNull();
    expect(driver.executed.filter((s) => !s.startsWith("insert"))).toEqual([]);
  });
});

describe("scope restore", () => {
  it("ammesso con restore consentito anche in readonly; altrimenti rifiutato", async () => {
    mode = "readonly";
    restore = true;
    driver.reply = (q) => (q.sql.startsWith("select *") ? { rows: [] } : undefined);
    await withWriteScope("restore", () => k.deleteFrom("config").where("id", "=", 1).execute());
    restore = false;
    await expect(withWriteScope("restore", () => k.deleteFrom("config").where("id", "=", 1).execute())).rejects.toBeInstanceOf(ReadOnlyModeError);
    // lo scope admin resta bloccato in readonly anche con restore consentito
    restore = true;
    await expect(withWriteScope("admin", () => k.deleteFrom("config").where("id", "=", 1).execute())).rejects.toBeInstanceOf(ReadOnlyModeError);
  });

  it("le scritture dell'annullamento sono catturate a loro volta (si possono rifare)", async () => {
    mode = "readonly";
    restore = true;
    driver.reply = (q) => {
      if (q.sql.startsWith("select `id`, `value` from `ost_config`")) return { rows: [{ id: 1, value: "c" }] };
      if (q.sql.startsWith("update")) return { rows: [], numAffectedRows: 1n };
      if (q.sql.startsWith("SELECT `id`, `value`")) return { rows: [{ id: 1, value: "a" }] };
      if (q.sql.startsWith("insert")) return { rows: [] };
      if (q.sql.startsWith("SELECT * FROM `ost_config` WHERE `id` IN (?)")) return { rows: [{ id: 5, key: "k", value: "x" }] };
    };
    const rec = new ChangeRecorder();
    await withWriteScope("restore", () =>
      runWithRecorder(rec, () =>
        k.transaction().execute(async (tx) => {
          await applyRestoreOp(tx, { kind: "update", table: "ost_config", pk: { id: 1 }, set: { value: "a" } });
          await applyRestoreOp(tx, { kind: "insert", table: "ost_config", row: { id: 5, key: "k", value: "x" } });
        }),
      ),
    );
    expect(driver.executed).toContain("update `ost_config` set `value` = ? where `id` = ?");
    expect(rec.failure).toBeNull();
    expect(rec.entries).toEqual([
      { table: "ost_config", pk: { id: 1 }, before: { value: "c" }, after: { value: "a" } },
      { table: "ost_config", pk: { id: 5 }, before: null, after: { id: 5, key: "k", value: "x" } },
    ]);
  });
});
