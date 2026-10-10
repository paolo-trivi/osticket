import { CompiledQuery, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, sql, type DatabaseConnection, type Driver, type QueryResult } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";

import type { DB } from "@/server/db/schema.gen";
import { TablePrefixPlugin } from "@/server/db/table-prefix-plugin";
import { classifySql, withWriteGate, type CompletedWrite } from "@/server/db/write-gate";
import { ReadOnlyModeError, withWriteScope, type WriteMode } from "@/server/system/write-mode";

/** Driver finto: registra le query arrivate al "DB" (dopo il gate). */
class RecordingDriver implements Driver {
  executed: string[] = [];
  async init() {}
  async acquireConnection(): Promise<DatabaseConnection> {
    const executed = this.executed;
    return {
      async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
        executed.push(q.sql);
        return { rows: [] };
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

let mode: WriteMode | null = "full";
let driver: RecordingDriver;
let completed: CompletedWrite[];

function makeDb(): Kysely<DB> {
  driver = new RecordingDriver();
  return new Kysely<DB>({
    dialect: withWriteGate(
      {
        createAdapter: () => new MysqlAdapter(),
        createDriver: () => driver,
        createIntrospector: (d) => new MysqlIntrospector(d),
        createQueryCompiler: () => new MysqlQueryCompiler(),
      },
      {
        mode: async () => mode,
        completed: (e) => completed.push(e),
        collect: () => true,
      },
    ),
    plugins: [new TablePrefixPlugin("ost_")],
  });
}

let k: Kysely<DB>;
beforeEach(() => {
  mode = "full";
  completed = [];
  k = makeDb();
});

const insertSyslog = (db: Kysely<DB>) =>
  db
    .insertInto("syslog")
    .values({
      title: "t",
      log_type: "Debug",
      log: "",
      ip_address: "",
      logger: "",
      created: sql`NOW()`,
      updated: sql`NOW()`,
    })
    .execute();

describe("classifySql", () => {
  it("letture e controllo della transazione non sono scritture", () => {
    for (const q of [
      "select 1",
      "  /* c */ SELECT * FROM `ost_ticket` FOR UPDATE",
      "(select 1) union (select 2)",
      "SHOW TABLES",
      "begin",
      "commit",
      "rollback",
      "SET NAMES utf8, SESSION SQL_MODE = ''",
      "WITH x AS (SELECT 1) SELECT * FROM x FOR UPDATE",
    ]) {
      expect(classifySql(q).write, q).toBe(false);
    }
  });

  it("scritture con verbo e tabelle di destinazione", () => {
    expect(classifySql("insert into `ost_syslog` (`a`) values (?)")).toEqual({
      write: true,
      verb: "insert",
      tables: ["ost_syslog"],
    });
    expect(classifySql("INSERT IGNORE INTO `ost_attachment` (object_id) SELECT 1")).toMatchObject({ verb: "insert", tables: ["ost_attachment"] });
    expect(classifySql("REPLACE INTO `ost__search` SET object_type = ?")).toMatchObject({ verb: "replace", tables: ["ost__search"] });
    expect(classifySql("update `ost_ticket` set `lock_id` = ? where `ost_ticket`.`ticket_id` = ?")).toMatchObject({ verb: "update", tables: ["ost_ticket"] });
    expect(classifySql("UPDATE `ost_thread_entry_email` E JOIN `ost_thread_entry` H ON (H.id = E.thread_entry_id) SET E.x = 1")).toMatchObject({
      tables: ["ost_thread_entry_email", "ost_thread_entry"],
    });
    expect(classifySql("DELETE A FROM `ost_attachment` A JOIN `ost_draft` D ON (A.type = 'D') WHERE D.id = 1")).toMatchObject({
      verb: "delete",
      tables: ["ost_attachment", "ost_draft"],
    });
    expect(classifySql("delete from `ost_config` where `namespace` = ?")).toMatchObject({ verb: "delete", tables: ["ost_config"] });
    expect(classifySql("TRUNCATE TABLE `ost_syslog`")).toMatchObject({
      write: true,
      verb: "truncate",
    });
    expect(classifySql("SET GLOBAL sql_mode = ''").write).toBe(true);
    expect(classifySql("SELECT 1 INTO OUTFILE '/tmp/x'").write).toBe(true);
    expect(classifySql("WITH x AS (SELECT 1) DELETE FROM `ost_lock`")).toMatchObject({ write: true, verb: "delete", tables: ["ost_lock"] });
  });

  it("un nodo SelectQueryNode è sempre una lettura", () => {
    expect(classifySql("select 1 for update", "SelectQueryNode").write).toBe(false);
  });
});

describe("gate delle scritture", () => {
  it("SELECT ammessa in ogni modalità", async () => {
    mode = "readonly";
    await k.selectFrom("ticket").select("ticket_id").forUpdate().execute();
    await sql`SELECT lock_id FROM ${sql.table("lock")}`.execute(k);
    expect(driver.executed).toHaveLength(2);
  });

  it("readonly: insert, update, delete e sql raw rifiutati prima del DB", async () => {
    mode = "readonly";
    await withWriteScope("operational", async () => {
      await expect(insertSyslog(k)).rejects.toBeInstanceOf(ReadOnlyModeError);
      await expect(
        k
          .updateTable("staff")
          .set({ lastlogin: sql`NOW()` })
          .where("staff_id", "=", 1)
          .execute(),
      ).rejects.toMatchObject({ code: "read_only" });
      await expect(k.deleteFrom("config").where("namespace", "=", "pwreset").execute()).rejects.toBeInstanceOf(ReadOnlyModeError);
      await expect(sql`DELETE FROM ${sql.table("lock")} WHERE lock_id = ${1}`.execute(k)).rejects.toBeInstanceOf(ReadOnlyModeError);
      await expect(k.executeQuery(CompiledQuery.raw("UPDATE ost_ticket SET lock_id = 0"))).rejects.toBeInstanceOf(ReadOnlyModeError);
    });
    expect(driver.executed).toEqual([]);
  });

  it("operational: scope operational ammesso, admin e scritture senza scope rifiutate", async () => {
    mode = "operational";
    await withWriteScope("operational", () => insertSyslog(k));
    expect(driver.executed).toHaveLength(1);
    await expect(withWriteScope("admin", () => insertSyslog(k))).rejects.toMatchObject({
      code: "read_only",
      scope: "admin",
      mode: "operational",
    });
    await expect(insertSyslog(k)).rejects.toMatchObject({ scope: "admin" });
    expect(driver.executed).toHaveLength(1);
  });

  it("full: tutto ammesso; nessun controllo con modalità null", async () => {
    mode = "full";
    await withWriteScope("admin", () => insertSyslog(k));
    await insertSyslog(k);
    mode = null;
    await insertSyslog(k);
    expect(driver.executed).toHaveLength(3);
  });

  it("transazione: rifiuto a metà → rollback, niente registro", async () => {
    mode = "operational";
    await expect(
      withWriteScope("operational", () =>
        k.transaction().execute(async (tx) => {
          await insertSyslog(tx);
          await withWriteScope("admin", () => tx.updateTable("config").set({ value: "x" }).where("id", "=", 1).execute());
        }),
      ),
    ).rejects.toBeInstanceOf(ReadOnlyModeError);
    expect(driver.executed[0]).toBe("begin");
    expect(driver.executed.at(-1)).toBe("rollback");
    expect(completed).toEqual([]);
  });

  it("registro: tabelle e verbi della transazione al commit, con lo scope e l'attore", async () => {
    await withWriteScope(
      "operational",
      () =>
        k.transaction().execute(async (tx) => {
          await tx.selectFrom("staff").select("staff_id").execute();
          await tx
            .updateTable("staff")
            .set({ lastlogin: sql`NOW()` })
            .where("staff_id", "=", 3)
            .execute();
          await tx.deleteFrom("config").where("namespace", "=", "pwreset").execute();
          await tx
            .updateTable("staff")
            .set({ updated: sql`NOW()` })
            .where("staff_id", "=", 3)
            .execute();
        }),
      { op: "agent.login", actor: { type: "agent", id: 3 } },
    );
    expect(completed).toEqual([
      {
        context: {
          scope: "operational",
          op: "agent.login",
          actor: { type: "agent", id: 3 },
        },
        tables: { ost_staff: ["update"], ost_config: ["delete"] },
      },
    ]);
    // scrittura fuori transazione: una voce subito
    await insertSyslog(k);
    expect(completed[1]).toEqual({
      context: undefined,
      tables: { ost_syslog: ["insert"] },
    });
  });
});
