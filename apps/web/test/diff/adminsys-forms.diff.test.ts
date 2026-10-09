import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db, type Tx } from "@/server/db";
import type { PhpVars } from "@/server/php/values";
import { deleteForms, saveForm } from "@/server/domain/adminsys/form";
import { addList, addListItem, deleteLists, massListItems, updateList, updateListItem, type ItemMassAction } from "@/server/domain/adminsys/list";

import { compareWorkingDatabases, execBoth, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";

/** Liste (scp/lists.php, ajax.forms.php) e form personalizzati (scp/forms.php): PHP vs TypeScript. */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

type R = { ok: boolean; id?: number | null; num?: number; errors?: Record<string, string> };
const tx = <T>(fn: (t: Tx) => Promise<T>) => db().transaction().execute(fn);
const keys = (e?: Record<string, string>) => Object.keys(e ?? {}).sort();

async function both(op: string, args: Record<string, unknown>, ts: (t: Tx) => Promise<R>, opts: { keys?: boolean } = {}): Promise<{ php: R; ts: R }> {
  const php = await runPhp<R>({ op, args: { agent: 1, ...args } });
  const r = await tx(ts);
  if (process.env.DEBUG_DIFF) console.log(JSON.stringify({ php, ts: r }));
  expect(r.ok).toBe(php.ok);
  if (opts.keys !== false) expect(keys(r.errors)).toEqual(keys(php.errors));
  if (php.ok && php.id) expect(r.id).toBe(php.id);
  return { php, ts: r };
}

describe("liste personalizzate: PHP vs TypeScript", () => {
  it("creazione con proprietà, modifica (ordinamento manuale, proprietà), errori, eliminazione", async () => {
    const add: PhpVars = { do: "add", name: "Prodotti & servizi", name_plural: "Prodotti", sort_mode: "SortCol", notes: "<p>Note<script>x</script></p>", "prop-sort-new-0": "", "prop-label-new-0": "Codice", "type-new-0": "text", "name-new-0": "codice", "prop-sort-new-1": "5", "prop-label-new-1": "", "type-new-1": "text", "name-new-1": "" };
    const r = await both("adminsys.list", { vars: add }, (t) => addList(t, add));
    expect(r.php.ok).toBe(true);
    const id = r.php.id!;
    await both("adminsys.list", { vars: { do: "add", name: "" } }, (t) => addList(t, { do: "add", name: "" }));
    // elementi
    const item = (vars: PhpVars) => both("adminsys.list.item", { list: id, action: "add", vars }, (t) => addListItem(t, id, vars));
    const a = await item({ value: " Alfa ", extra: "A" });
    await item({ value: "Beta", extra: "" });
    await item({ value: "Alfa", extra: "" });
    await item({ value: "", extra: "x" });
    await item({ value: "=SOMMA()", extra: "" });
    const ida = a.php.id!;
    const upd = { value: "Alfa 2", extra: "", codice: "X1" };
    await both("adminsys.list.item", { list: id, item: ida, action: "update", vars: upd }, (t) => updateListItem(t, id, ida, upd));
    const run = async (action: ItemMassAction, ids: number[]) => {
      const php = await runPhp<R>({ op: "adminsys.list.item", args: { agent: 1, list: id, action, vars: { ids: ids.map(String) } } });
      const ts = await tx((t) => massListItems(t, id, action, ids));
      expect(ts.num).toBe(php.num);
    };
    await run("disable", [ida]);
    await item({ value: "Alfa 2", extra: "" });
    await run("enable", [ida]);
    await run("delete", [ida + 1]);
    // modifica della lista: ordinamento manuale e proprietà
    const fields = await db().selectFrom("form_field").innerJoin("form", "form.id", "form_field.form_id").select("form_field.id").where("form.type", "=", `L${id}`).execute();
    const pid = fields[0].id;
    const upd2: PhpVars = { do: "update", name: "Prodotti", name_plural: "", sort_mode: "SortCol", notes: "", [`sort-${ida}`]: "3", [`prop-label-${pid}`]: "Codice articolo", [`name-${pid}`]: "cod.art", "prop-sort-new-0": "", "prop-label-new-0": "Note", "type-new-0": "memo", "name-new-0": "note" };
    await both("adminsys.list", { id, vars: upd2 }, (t) => updateList(t, id, upd2));
    const upd3: PhpVars = { do: "update", name: "Prodotti", sort_mode: "Alpha", [`delete-prop-${pid}`]: "on" };
    await both("adminsys.list", { id, vars: upd3 }, (t) => updateList(t, id, upd3));
    // eliminazione: lista usata da un campo → rifiutata
    await execBoth(`INSERT INTO {p}form_field (form_id, type, label, name, sort, created, updated) VALUES (2, 'list-${id}', 'Prodotto', 'prodotto', 9, NOW(), NOW())`);
    const del1 = await runPhp<R>({ op: "adminsys.list", args: { agent: 1, vars: { do: "mass_process", a: "delete", ids: [String(id)] } } });
    const tdel1 = await tx((t) => deleteLists(t, [id]));
    expect(tdel1.num).toBe(del1.num);
    await execBoth(`DELETE FROM {p}form_field WHERE type = 'list-${id}'`);
    const del2 = await runPhp<R>({ op: "adminsys.list", args: { agent: 1, vars: { do: "mass_process", a: "delete", ids: [String(id)] } } });
    const tdel2 = await tx((t) => deleteLists(t, [id]));
    expect(tdel2.num).toBe(del2.num);
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

describe("form personalizzati: PHP vs TypeScript", () => {
  it("nuovo form G con campi, modifica (etichette, nomi, eliminazione), errori, eliminazione logica", async () => {
    const add: PhpVars = { do: "add", title: "Richiesta <b>hardware</b>", instructions: "<p>Compila</p>", notes: "n", "sort-new-0": "", "label-new-0": "Modello", "type-new-0": "text", "name-new-0": " modello ", "visibility-new-0": "b", "sort-new-1": "", "label-new-1": "Note", "type-new-1": "memo", "name-new-1": "", "visibility-new-1": "e" };
    const r = await both("adminsys.form", { vars: add }, (t) => saveForm(t, null, add));
    expect(r.php.ok).toBe(true);
    const id = r.php.id!;
    const fields = await db().selectFrom("form_field").select(["id", "name"]).where("form_id", "=", id).orderBy("sort").execute();
    const [f1, f2] = fields.map((f) => f.id);
    const upd: PhpVars = { do: "update", title: "Richiesta HW", instructions: "", notes: "", [`label-${f1}`]: "Modello PC", [`name-${f1}`]: "modello_pc", [`sort-${f1}`]: "2", [`type-${f2}`]: "text", "sort-new-0": "", "label-new-0": "Seriale", "type-new-0": "text", "name-new-0": "seriale", "visibility-new-0": "a" };
    await both("adminsys.form", { id, vars: upd }, (t) => saveForm(t, id, upd));
    // errori: nome duplicato, nome non valido, nome obbligatorio per campo richiesto
    const bad: PhpVars = { do: "update", title: "X", [`name-${f1}`]: "seriale", "sort-new-0": "", "label-new-0": "Y", "type-new-0": "text", "name-new-0": "1abc", "visibility-new-0": "b" };
    await both("adminsys.form", { id, vars: bad }, (t) => saveForm(t, id, bad));
    await both("adminsys.form", { vars: { do: "add", title: "" } }, (t) => saveForm(t, null, { do: "add", title: "" }));
    // eliminazione di un campo con dati (staccato) e senza dati
    await execBoth(`INSERT INTO {p}form_entry_values (entry_id, field_id, value) VALUES (1, ${f2}, 'x')`);
    const del: PhpVars = { do: "update", title: "Richiesta HW", [`delete-${f2}`]: "on", [`delete-${f1}`]: "on" };
    await both("adminsys.form", { id, vars: del }, (t) => saveForm(t, id, del));
    // eliminazione logica (solo form con FLAG_DELETABLE)
    const php = await runPhp<R>({ op: "adminsys.form", args: { agent: 1, vars: { do: "mass_process", a: "delete", ids: [String(id), "2"] } } });
    const ts = await tx((t) => deleteForms(t, [id, 2]));
    expect(ts.num).toBe(php.num);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("form dei ticket: etichette e ordinamento sì, nuovi campi o cambio nome/tipo rifiutati (DDL cdata)", async () => {
    const ok: PhpVars = { do: "update", title: "Ticket Details", instructions: "Please Describe Your Issue", notes: "", "label-20": "Oggetto", "sort-22": "5" };
    await both("adminsys.form", { id: 2, vars: ok }, (t) => saveForm(t, 2, ok));
    const ddl: PhpVars = { do: "update", title: "Ticket Details", "sort-new-0": "", "label-new-0": "Extra", "type-new-0": "text", "name-new-0": "extra" };
    const ts = await tx((t) => saveForm(t, 2, ddl));
    expect(ts).toMatchObject({ ok: false, errors: { err: "ddl_required" } });
    // il nome di "subject" è bloccato (FLAG_MASK_NAME): nessun cambio, nessun DDL
    const locked: PhpVars = { do: "update", title: "Ticket Details", instructions: "Please Describe Your Issue", "name-20": "oggetto" };
    await both("adminsys.form", { id: 2, vars: locked }, (t) => saveForm(t, 2, locked));
    await execBoth("INSERT INTO {p}form_field (id, form_id, flags, type, label, name, sort, created, updated) VALUES (90, 2, 1, 'text', 'Extra', 'extra', 9, NOW(), NOW())");
    const rename = await tx((t) => saveForm(t, 2, { do: "update", title: "Ticket Details", "name-90": "altro" }));
    expect(rename.errors.err).toBe("ddl_required");
    const retype = await tx((t) => saveForm(t, 2, { do: "update", title: "Ticket Details", "type-90": "memo" }));
    expect(retype.errors.err).toBe("ddl_required");
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
