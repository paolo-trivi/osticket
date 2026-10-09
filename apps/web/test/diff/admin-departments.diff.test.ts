import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db, type Tx } from "@/server/db";
import { massDept, saveDept, type DeptMassAction } from "@/server/domain/admin/dept";
import type { PhpVars } from "@/server/php/values";

import { compareWorkingDatabases, execBoth, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";

/** Reparti (scp/departments.php → Dept::update/create/delete, mass_process). */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

type R = { ok: boolean; id?: number | null; errors?: Record<string, string>; num?: number; error?: string };
const tx = <T>(fn: (t: Tx) => Promise<T>) => db().transaction().execute(fn);

async function save(id: number | null, vars: PhpVars): Promise<{ php: R; ts: R }> {
  const php = await runPhp<R>({ op: "admin.dept.save", args: { agent: 1, id, vars } });
  const ts = await tx((t) => saveDept(t, id, vars));
  return { php, ts };
}

async function mass(a: DeptMassAction, ids: number[]): Promise<{ php: R; ts: R }> {
  const php = await runPhp<R>({ op: "admin.dept.mass", args: { agent: 1, a, ids: ids.map(String) } });
  const ts = await tx((t) => massDept(t, a, ids));
  return { php, ts };
}

const SALES: PhpVars = {
  do: "update",
  id: "2",
  pid: "",
  status: "active",
  ispublic: "1",
  sla_id: "1",
  schedule_id: "0",
  manager_id: "0",
  assignment_flag: "all",
  name: "Sales",
  signature: "",
  email_id: "0",
  tpl_id: "0",
  autoresp_email_id: "0",
  group_membership: "1",
  members: ["1"],
  member_role: { "1": "1" },
  member_alerts: { "1": "1" },
};

const keys = (e?: Record<string, string>) => Object.keys(e ?? {}).sort();

describe("reparti: PHP vs TypeScript", () => {
  it("modifica: dati, flag, accessi estesi (nuovo, ruolo, avvisi), ruolo del membro primario; poi salvataggio identico", async () => {
    const vars: PhpVars = {
      ...SALES,
      name: "Vendite <i>",
      signature: "<p>Ufficio vendite<script>x</script></p>",
      status: "disabled",
      ispublic: "0",
      manager_id: "4",
      assignment_flag: "members",
      disable_auto_claim: "on",
      disable_reopen_auto_assign: "on",
      ticket_auto_response: "0",
      group_membership: "2",
      members: ["1", "2", "4"],
      member_role: { "1": "3", "2": "2", "4": "2" },
      member_alerts: { "2": "1" },
    };
    const r = await save(2, vars);
    expect(r.php).toMatchObject({ ok: true, id: 2 });
    expect(r.ts).toMatchObject({ ok: true, id: 2 });
    const again = await save(2, vars);
    expect(again.ts.ok).toBe(again.php.ok);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("rimozione degli accessi estesi non più elencati", async () => {
    const r = await save(3, { ...SALES, id: "3", name: "Maintenance", sla_id: "0", members: ["2"], member_role: { "2": "1" }, member_alerts: {} });
    expect(r.ts.ok).toBe(true);
    expect(r.php.ok).toBe(true);
    const r2 = await save(3, { ...SALES, id: "3", name: "Maintenance", members: undefined, member_role: undefined, member_alerts: undefined });
    expect(r2.ts.ok).toBe(r2.php.ok);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("creazione: sotto-reparto con percorso, membri estesi e stato archiviato", async () => {
    const vars: PhpVars = {
      ...SALES,
      do: "create",
      id: "",
      pid: "1",
      name: "Supporto 2° livello",
      status: "active",
      assignment_flag: "primary",
      members: ["3"],
      member_role: { "3": "1" },
      member_alerts: {},
    };
    const r = await save(null, vars);
    expect(r.php.ok).toBe(true);
    expect(r.ts).toMatchObject({ ok: true, id: r.php.id });
    const child = await save(null, { ...vars, pid: String(r.php.id), name: "Terzo livello", members: undefined, status: "archived" });
    expect(child.ts).toMatchObject({ ok: true, id: child.php.id });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("errori di validazione: nome duplicato, reparto predefinito privato, padre ciclico, riferimenti inesistenti, ruolo membro", async () => {
    const dup = await save(3, { ...SALES, id: "3", name: "Sales" });
    expect(keys(dup.ts.errors)).toEqual(keys(dup.php.errors));
    const priv = await save(1, { ...SALES, id: "1", name: "Support", ispublic: "0" });
    expect(keys(priv.ts.errors)).toEqual(keys(priv.php.errors));
    const refs = await save(2, { ...SALES, sla_id: "99", manager_id: "99", email_id: "99", tpl_id: "99", members: ["2"], member_role: { "2": "0" } });
    expect(keys(refs.ts.errors)).toEqual(keys(refs.php.errors));
    const noName = await save(null, { ...SALES, id: "", name: "" });
    expect(keys(noName.ts.errors)).toEqual(keys(noName.php.errors));
    // ciclo: il reparto 1 non può avere come padre un suo discendente
    await execBoth("INSERT INTO {p}department (id, pid, flags, name, signature, path, created, updated) VALUES (10, 1, 4, 'Figlio', '', '/1/10/', NOW(), NOW())");
    const loop = await save(1, { ...SALES, id: "1", name: "Support", pid: "10" });
    expect(loop.php.ok).toBe(false);
    expect(keys(loop.ts.errors)).toEqual(keys(loop.php.errors));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("azioni di massa: abilita/disabilita/archivia, pubblico/privato (query errata del PHP), predefinito escluso", async () => {
    expect((await mass("disable", [2, 3])).ts).toMatchObject({ ok: true, num: 2 });
    expect((await mass("archive", [3])).ts).toMatchObject({ ok: true, num: 1 });
    expect((await mass("enable", [2])).ts).toMatchObject({ ok: true, num: 1 });
    const pub = await mass("make_private", [2]);
    expect(pub.php.ok).toBe(false);
    expect(pub.ts.ok).toBe(false);
    const def = await mass("disable", [1, 2]);
    expect(def.php.ok).toBe(false);
    expect(def.ts.ok).toBe(false);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("eliminazione: rifiutata con membri; reparto vuoto con ticket, task, topic, email e accessi spostati", async () => {
    const withMembers = await mass("delete", [3]);
    expect(withMembers.php.ok).toBe(false);
    expect(withMembers.ts.ok).toBe(false);
    await execBoth(
      "INSERT INTO {p}department (id, flags, name, signature, path, created, updated) VALUES (10, 4, 'Temporaneo', '', '/10/', NOW(), NOW())",
      "UPDATE {p}ticket SET dept_id = 10 WHERE ticket_id IN (1, 2)",
      "UPDATE {p}task SET dept_id = 10 WHERE id = 1",
      "UPDATE {p}help_topic SET dept_id = 10 WHERE topic_id = 2",
      "UPDATE {p}email SET dept_id = 10 WHERE email_id = 2",
      "INSERT INTO {p}staff_dept_access (staff_id, dept_id, role_id, flags) VALUES (2, 10, 1, 1)",
    );
    const r = await mass("delete", [10]);
    expect(r.php).toMatchObject({ ok: true, num: 1 });
    expect(r.ts).toMatchObject({ ok: true, num: 1 });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("eliminazione di un reparto usato da un filtro: il PHP va in errore fatale a metà, TS rifiuta senza scrivere", async () => {
    await execBoth(
      "INSERT INTO {p}department (id, flags, name, signature, path, created, updated) VALUES (10, 4, 'Instradato', '', '/10/', NOW(), NOW())",
      "INSERT INTO {p}filter (id, execorder, isactive, flags, target, name, created, updated) VALUES (2, 10, 1, 0, 'Any', 'Instrada', NOW(), NOW())",
      "INSERT INTO {p}filter_action (filter_id, sort, type, configuration, updated) VALUES (2, 1, 'dept', '{\"dept_id\":10}', NOW())",
    );
    const ts = await tx((t) => massDept(t, "delete", [10]));
    expect(ts).toMatchObject({ ok: false, error: "filter" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
