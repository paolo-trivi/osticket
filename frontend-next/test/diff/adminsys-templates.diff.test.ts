import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db, type Tx } from "@/server/db";
import type { PhpVars } from "@/server/domain/admin/php";
import { addTemplateGroup, implementTemplate, massTemplateGroups, updateTemplate, updateTemplateGroup, type TemplateMassAction } from "@/server/domain/adminsys/template";

import { compareWorkingDatabases, execBoth, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";

/** Template email (scp/templates.php): PHP vs TypeScript. */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

type R = { ok: boolean; id?: number | null; num?: number; errors?: Record<string, string> };
const tx = <T>(fn: (t: Tx) => Promise<T>) => db().transaction().execute(fn);
const keys = (e?: Record<string, string>) => Object.keys(e ?? {}).sort();

async function both(vars: PhpVars, ts: (t: Tx) => Promise<R>, request: PhpVars = {}): Promise<{ php: R; ts: R }> {
  const php = await runPhp<R>({ op: "adminsys.template", args: { agent: 1, vars, request } });
  const r = await tx(ts);
  if (process.env.DEBUG_DIFF) console.log(JSON.stringify({ php, ts: r }));
  expect(r.ok).toBe(php.ok);
  expect(keys(r.errors)).toEqual(keys(php.errors));
  if (php.ok && php.id) expect(r.id).toBe(php.id);
  return { php, ts: r };
}

const IMG = '<img src="cid:b56944cb4722cc5cda9d1e23a3ea7fbc" />';

describe("template email: PHP vs TypeScript", () => {
  it("set: nuovo, clonato, modifica, errori (nome, in uso)", async () => {
    const add = { do: "add", name: " Italiano <b>2</b> ", isactive: "1", lang_id: "it", notes: "<p>Set</p>" };
    const r = await both(add, (t) => addTemplateGroup(t, add));
    expect(r.php.ok).toBe(true);
    const clone = { do: "add", name: "Clone", isactive: "0", tpl_id: "1", notes: "" };
    await both(clone, (t) => addTemplateGroup(t, clone));
    await both({ do: "add", name: "Clone", isactive: "1" }, (t) => addTemplateGroup(t, { do: "add", name: "Clone", isactive: "1" }));
    await both({ do: "add", name: "", isactive: "1", tpl_id: "99" }, (t) => addTemplateGroup(t, { do: "add", name: "", isactive: "1", tpl_id: "99" }));
    const id = r.php.id!;
    const upd = { do: "update", tpl_id: String(id), name: "Italiano", isactive: "0", notes: "nuove" };
    await both(upd, (t) => updateTemplateGroup(t, id, upd));
    // set predefinito: non disattivabile
    const def = { do: "update", tpl_id: "1", name: "osTicket Default Template (HTML)", isactive: "0", notes: "" };
    await both(def, (t) => updateTemplateGroup(t, 1, def));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("messaggi: modifica (immagini inline e bozze), implementazione di un messaggio mancante, errori", async () => {
    await execBoth(
      "INSERT INTO {p}draft (id, staff_id, namespace, body, created) VALUES (90, 1, 'tpl.ticket.alert.1', 'x', NOW()), (91, 2, 'tpl.ticket.alert.1', 'y', NOW()), (92, 1, 'tpl.ticket.reply.1', 'z', NOW())",
      "INSERT INTO {p}attachment (object_id, type, file_id, inline) VALUES (90, 'D', 1, 1)",
    );
    const upd = { do: "updatetpl", id: "8", a: "manage", subject: "Nuovo ticket #%{ticket.number} <b>x</b>", body: `<p>Ciao<script>x</script></p>${IMG}` };
    await both(upd, (t) => updateTemplate(t, 8, upd));
    const noimg = { do: "updatetpl", id: "9", subject: "S", body: "<p>Senza immagine</p>" };
    await both(noimg, (t) => updateTemplate(t, 9, noimg));
    await both({ do: "updatetpl", id: "10", subject: "", body: "" }, (t) => updateTemplate(t, 10, { do: "updatetpl", subject: "", body: "" }));
    // set nuovo senza messaggi: implementazione
    const add = { do: "add", name: "Vuoto", isactive: "1" };
    const g = await both(add, (t) => addTemplateGroup(t, add));
    const tplId = g.php.id!;
    const impl = { do: "implement", tpl_id: String(tplId), code_name: "ticket.alert", subject: "Avviso", body: `<p>Corpo</p>${IMG}` };
    await both(impl, (t) => implementTemplate(t, tplId, impl, 1));
    const bad = { do: "implement", tpl_id: String(tplId), code_name: "", subject: "x", body: "y" };
    await both(bad, (t) => implementTemplate(t, tplId, bad, 1));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("azioni di massa: disattiva, attiva, elimina (set in uso esclusi)", async () => {
    const a = await both({ do: "add", name: "A", isactive: "1", tpl_id: "1" }, (t) => addTemplateGroup(t, { do: "add", name: "A", isactive: "1", tpl_id: "1" }));
    const b = await both({ do: "add", name: "B", isactive: "0" }, (t) => addTemplateGroup(t, { do: "add", name: "B", isactive: "0" }));
    const [ia, ib] = [a.php.id!, b.php.id!];
    await execBoth(`UPDATE {p}department SET tpl_id = ${ib} WHERE id = 2`);
    const run = async (action: TemplateMassAction, ids: number[]) => {
      const php = await runPhp<R>({ op: "adminsys.template", args: { agent: 1, vars: { do: "mass_process", a: action, ids: ids.map(String) } } });
      const ts = await tx((t) => massTemplateGroups(t, action, ids));
      expect(ts.ok).toBe(php.ok);
      expect(ts.num).toBe(php.num);
    };
    await run("disable", [1, ia, ib]);
    await run("enable", [ia, ib]);
    await run("enable", [ia]);
    await run("delete", [1, ia, ib]);
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
