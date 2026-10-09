import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db, type Tx } from "@/server/db";
import type { PhpVars } from "@/server/php/values";
import { massRoles, saveRole, type RoleMassAction } from "@/server/domain/admin/role";
import { massSla, saveSla, type SlaMassAction } from "@/server/domain/admin/sla";
import { massTeams, saveTeam, type TeamMassAction } from "@/server/domain/admin/team";
import { massTopics, saveTopic, type TopicMassAction } from "@/server/domain/admin/topic";

import { compareWorkingDatabases, execBoth, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";

/** Help topic, SLA, team e ruoli: PHP (scp/helptopics.php, slas.php, teams.php, roles.php) vs TypeScript. */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

type R = { ok: boolean; id?: number | null; errors?: Record<string, string>; num?: number; error?: string };
const tx = <T>(fn: (t: Tx) => Promise<T>) => db().transaction().execute(fn);
const keys = (e?: Record<string, string>) => Object.keys(e ?? {}).sort();

async function both(op: string, id: number | null, vars: PhpVars, ts: (t: Tx) => Promise<R>): Promise<{ php: R; ts: R }> {
  const php = await runPhp<R>({ op, args: { agent: 1, id, vars } });
  return { php, ts: await tx(ts) };
}

const TOPIC: PhpVars = {
  do: "update",
  id: "2",
  topic: "Feedback",
  topic_pid: "0",
  status: "active",
  ispublic: "1",
  dept_id: "0",
  priority_id: "1",
  sla_id: "0",
  page_id: "0",
  assign: "",
  number_format: "",
  sequence_id: "0",
  notes: "Tickets that primarily concern the sales and billing departments",
  forms: ["2"],
  fields: ["20", "21", "22"],
};

describe("help topic: PHP vs TypeScript", () => {
  it("modifica: nome, reparto, assegnazione, numerazione, form associati e ordinamento alfabetico", async () => {
    const vars: PhpVars = {
      ...TOPIC,
      topic: "  Commenti e <b>suggerimenti</b> ",
      dept_id: "2",
      priority_id: "3",
      sla_id: "1",
      assign: "s4",
      "custom-numbers": "1",
      number_format: "FB-####",
      sequence_id: "1",
      noautoresp: "on",
      notes: "<p>Note<script>x</script></p>",
      forms: ["5", "2"],
      fields: ["20", "21", "32"],
    };
    const r = await both("admin.topic.save", 2, vars, (t) => saveTopic(t, 2, vars));
    expect(r.php).toMatchObject({ ok: true, id: 2 });
    expect(r.ts).toMatchObject({ ok: true, id: 2 });
    const again = await both("admin.topic.save", 2, { ...vars, assign: "t1", forms: ["2"] }, (t) => saveTopic(t, 2, { ...vars, assign: "t1", forms: ["2"] }));
    expect(again.ts.ok).toBe(again.php.ok);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("creazione: sotto-topic (sort del padre + 1), stato disabilitato, form", async () => {
    const vars: PhpVars = { ...TOPIC, do: "create", id: "", topic: "Guasto apparecchiature", topic_pid: "10", status: "disabled", ispublic: "0", forms: ["2"], fields: undefined };
    const r = await both("admin.topic.save", null, vars, (t) => saveTopic(t, null, vars));
    expect(r.php.ok).toBe(true);
    expect(r.ts).toMatchObject({ ok: true, id: r.php.id });
    const second = { ...vars, topic: "Accesso negato", topic_pid: "0", status: "archived", ispublic: "1" };
    const r2 = await both("admin.topic.save", null, second, (t) => saveTopic(t, null, second));
    expect(r2.ts).toMatchObject({ ok: true, id: r2.php.id });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("errori: nome corto o duplicato, reparto non attivo, formato numero, ultimo topic pubblico/attivo", async () => {
    const short = await both("admin.topic.save", 2, { ...TOPIC, topic: "Abc" }, (t) => saveTopic(t, 2, { ...TOPIC, topic: "Abc" }));
    expect(keys(short.ts.errors)).toEqual(keys(short.php.errors));
    const dup = { ...TOPIC, topic: "General Inquiry", "custom-numbers": "1", number_format: "ABC" };
    const r = await both("admin.topic.save", 2, dup, (t) => saveTopic(t, 2, dup));
    expect(keys(r.ts.errors)).toEqual(keys(r.php.errors));
    await execBoth("UPDATE {p}department SET flags = 0 WHERE id = 3");
    const inactive = { ...TOPIC, dept_id: "3" };
    const r2 = await both("admin.topic.save", 2, inactive, (t) => saveTopic(t, 2, inactive));
    expect(keys(r2.ts.errors)).toEqual(keys(r2.php.errors));
    await execBoth("UPDATE {p}help_topic SET ispublic = 0, flags = 0 WHERE topic_id <> 2");
    const last = { ...TOPIC, ispublic: "0", status: "disabled" };
    const r3 = await both("admin.topic.save", 2, last, (t) => saveTopic(t, 2, last));
    expect(r3.php.ok).toBe(false);
    expect(keys(r3.ts.errors)).toEqual(keys(r3.php.errors));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("azioni di massa: disabilita, archivia, abilita, elimina (FAQ, ticket, figli), ordinamento manuale", async () => {
    const run = async (a: TopicMassAction, ids: number[], post: PhpVars = {}) => {
      const php = await runPhp<R>({ op: "admin.topic.mass", args: { agent: 1, a, ids: ids.map(String), post } });
      const ts = await tx((t) => massTopics(t, a, ids, post));
      expect(ts.ok).toBe(php.ok);
      return { php, ts };
    };
    await run("disable", [2, 11]);
    await run("archive", [1]);
    await run("enable", [1, 2]);
    await execBoth("UPDATE {p}ticket SET topic_id = 10 WHERE ticket_id IN (3, 4)");
    await run("delete", [10]);
    const all = await run("disable", [1, 2, 11]);
    expect(all.php.ok).toBe(false);
    // primo passaggio a "manuale": la chiave nuova non è ancora letta dal PHP (ordine ignorato)
    await run("sort", [], { help_topic_sort_mode: "m", "sort-1": "3", "sort-2": "1", "sort-11": "2" });
    await run("sort", [], { help_topic_sort_mode: "m", "sort-1": "3", "sort-2": "1", "sort-11": "2" });
    await run("sort", [], { help_topic_sort_mode: "x" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

const SLA: PhpVars = { do: "update", id: "1", name: "Default SLA", grace_period: "18", schedule_id: "0", isactive: "1", notes: "" };

describe("SLA: PHP vs TypeScript", () => {
  it("modifica, creazione ed errori", async () => {
    const vars = { ...SLA, name: "SLA <base> & co", grace_period: "24", schedule_id: "1", disable_overdue_alerts: "on", transient: "on", notes: "<p>nota</p>" };
    const r = await both("admin.sla.save", 1, vars, (t) => saveSla(t, 1, vars));
    expect(r.ts).toMatchObject({ ok: true, id: 1 });
    expect(r.php).toMatchObject({ ok: true, id: 1 });
    const nv = { ...SLA, do: "add", id: "", name: "Urgente", grace_period: "4", isactive: "0" };
    const c = await both("admin.sla.save", null, nv, (t) => saveSla(t, null, nv));
    expect(c.ts).toMatchObject({ ok: true, id: c.php.id });
    for (const bad of [
      { ...SLA, grace_period: "" },
      { ...SLA, grace_period: "abc" },
      { ...SLA, grace_period: "9000", name: "" },
      { ...SLA, id: "", name: "Urgente" },
    ]) {
      const e = await both("admin.sla.save", null, bad, (t) => saveSla(t, null, bad));
      expect(e.php.ok).toBe(false);
      expect(keys(e.ts.errors)).toEqual(keys(e.php.errors));
    }
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("nome con entità: Format::htmlchars ricodifica quelle sconosciute o fuori intervallo", async () => {
    const vars = { ...SLA, name: "R&D &foo; &eacute; &#1114112; &#39;" };
    const r = await both("admin.sla.save", 1, vars, (t) => saveSla(t, 1, vars));
    expect(r.ts).toMatchObject({ ok: true, id: 1 });
    expect(r.php).toMatchObject({ ok: true, id: 1 });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("azioni di massa ed eliminazione (reparti, topic, ticket allo SLA predefinito)", async () => {
    await execBoth(
      "INSERT INTO {p}sla (id, flags, grace_period, name, created, updated) VALUES (5, 3, 8, 'Breve', NOW(), NOW())",
      "UPDATE {p}department SET sla_id = 5 WHERE id = 3",
      "UPDATE {p}help_topic SET sla_id = 5 WHERE topic_id = 11",
      "UPDATE {p}ticket SET sla_id = 5 WHERE ticket_id IN (1, 5)",
    );
    const run = async (a: SlaMassAction, ids: number[]) => {
      const php = await runPhp<R>({ op: "admin.sla.mass", args: { agent: 1, a, ids: ids.map(String) } });
      const ts = await tx((t) => massSla(t, a, ids));
      expect(ts.ok).toBe(php.ok);
    };
    await run("disable", [1, 5]);
    await run("enable", [5]);
    await run("delete", [1, 5]);
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

describe("team: PHP vs TypeScript", () => {
  const TEAM: PhpVars = { do: "update", id: "1", name: "Level I Support", isenabled: "1", lead_id: "0", notes: "", members: ["2", "3"], member_alerts: {} };

  it("modifica (capo team, avvisi, membri aggiunti e rimossi), creazione, errori", async () => {
    const vars = { ...TEAM, name: "Primo livello", lead_id: "3", noalerts: "on", notes: "<b>n</b>", members: ["3", "4"], member_alerts: { "4": "1" } };
    const r = await both("admin.team.save", 1, vars, (t) => saveTeam(t, 1, vars));
    expect(r.ts).toMatchObject({ ok: true, id: 1 });
    const nv = { ...TEAM, do: "create", id: "", name: "Reperibili", isenabled: "", members: ["5"], member_alerts: { "5": "1" } };
    const c = await both("admin.team.save", null, nv, (t) => saveTeam(t, null, nv));
    expect(c.ts).toMatchObject({ ok: true, id: c.php.id });
    const dup = { ...nv, name: "Primo livello" };
    const e = await both("admin.team.save", null, dup, (t) => saveTeam(t, null, dup));
    expect(keys(e.ts.errors)).toEqual(keys(e.php.errors));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("azioni di massa ed eliminazione (membri, ticket del team)", async () => {
    await execBoth("UPDATE {p}ticket SET team_id = 1 WHERE ticket_id IN (2, 3)");
    const run = async (a: TeamMassAction, ids: number[]) => {
      const php = await runPhp<R>({ op: "admin.team.mass", args: { agent: 1, a, ids: ids.map(String) } });
      const ts = await tx((t) => massTeams(t, a, ids));
      expect(ts.ok).toBe(php.ok);
    };
    await run("disable", [1]);
    await run("enable", [1]);
    await run("delete", [1]);
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

describe("ruoli: PHP vs TypeScript", () => {
  it("modifica (permessi JSON), creazione, errori", async () => {
    const vars: PhpVars = { do: "update", id: "3", name: "Accesso limitato", notes: "<i>note</i>", perms: ["ticket.close", "ticket.assign", "task.close", "canned.manage"] };
    const r = await both("admin.role.save", 3, vars, (t) => saveRole(t, 3, vars));
    expect(r.ts).toMatchObject({ ok: true, id: 3 });
    const v4 = { do: "update", id: "4", name: "View only", notes: "", perms: ["ticket.edit"] };
    expect((await both("admin.role.save", 4, v4, (t) => saveRole(t, 4, v4))).ts.ok).toBe(true);
    const nv: PhpVars = { do: "add", id: "", name: "Supervisori", notes: "", perms: ["ticket.delete", "ticket.merge", "user.create"] };
    const c = await both("admin.role.save", null, nv, (t) => saveRole(t, null, nv));
    expect(c.ts).toMatchObject({ ok: true, id: c.php.id });
    for (const bad of [{ ...nv, name: "" }, { ...nv, name: "All Access" }, { ...nv, name: "Nuovo", perms: [] }]) {
      const e = await both("admin.role.save", null, bad, (t) => saveRole(t, null, bad));
      expect(e.php.ok).toBe(false);
      expect(keys(e.ts.errors)).toEqual(keys(e.php.errors));
    }
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("azioni di massa: disabilita/abilita, eliminazione solo dei ruoli non in uso", async () => {
    const run = async (a: RoleMassAction, ids: number[]) => {
      const php = await runPhp<R>({ op: "admin.role.mass", args: { agent: 1, a, ids: ids.map(String) } });
      const ts = await tx((t) => massRoles(t, a, ids));
      expect(ts.ok).toBe(php.ok);
    };
    await execBoth("INSERT INTO {p}role (id, flags, name, permissions, created, updated) VALUES (9, 1, 'Vuoto', '{}', NOW(), NOW())");
    await run("disable", [2, 9]);
    await run("enable", [9]);
    await run("delete", [1, 9]);
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
