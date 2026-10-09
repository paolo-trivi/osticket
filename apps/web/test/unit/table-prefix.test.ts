import { DummyDriver, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler } from "kysely";
import { describe, expect, it } from "vitest";

import type { DB } from "@/server/db/schema.gen";
import { TablePrefixPlugin } from "@/server/db/table-prefix-plugin";

const k = new Kysely<DB>({
  dialect: {
    createAdapter: () => new MysqlAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (d) => new MysqlIntrospector(d),
    createQueryCompiler: () => new MysqlQueryCompiler(),
  },
  plugins: [new TablePrefixPlugin("ost_")],
});

describe("TablePrefixPlugin", () => {
  it("prefissa tabelle, join e riferimenti qualificati", () => {
    const q = k
      .selectFrom("ticket")
      .innerJoin("thread", (j) =>
        j.onRef("thread.object_id", "=", "ticket.ticket_id").on("thread.object_type", "=", "T"),
      )
      .select(["ticket.number", "thread.id"])
      .compile();
    expect(q.sql).toBe(
      "select `ost_ticket`.`number`, `ost_thread`.`id` from `ost_ticket` inner join `ost_thread` on `ost_thread`.`object_id` = `ost_ticket`.`ticket_id` and `ost_thread`.`object_type` = ?",
    );
  });

  it("lascia intatti alias e colonne con lo stesso nome di una tabella", () => {
    const q = k
      .selectFrom("user as u")
      .innerJoin("user_email as ue", "ue.id", "u.default_email_id")
      .select(["u.name", "ue.address"])
      .compile();
    expect(q.sql).toBe(
      "select `u`.`name`, `ue`.`address` from `ost_user` as `u` inner join `ost_user_email` as `ue` on `ue`.`id` = `u`.`default_email_id`",
    );
  });

  it("prefissa insert e update", () => {
    expect(k.insertInto("config").values({ namespace: "core", key: "k", value: "v", updated: "2026-01-01 00:00:00" }).compile().sql).toContain(
      "insert into `ost_config`",
    );
    expect(k.updateTable("ticket").set({ isoverdue: 0 }).where("ticket_id", "=", 1).compile().sql).toBe(
      "update `ost_ticket` set `isoverdue` = ? where `ticket_id` = ?",
    );
  });
});
