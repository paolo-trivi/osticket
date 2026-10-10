import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db, type Tx } from "@/server/db";
import type { PhpVars } from "@/server/php/values";
import { massFilters, saveFilter, type FilterMassAction } from "@/server/domain/adminsys/filter";

import { compareWorkingDatabases, execBoth, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";

/** Filtri dei ticket (scp/filters.php): PHP vs TypeScript. */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

type R = { ok: boolean; id?: number | null; num?: number; errors?: Record<string, string> };
const tx = <T>(fn: (t: Tx) => Promise<T>) => db().transaction().execute(fn);
const keys = (e?: Record<string, string>) => Object.keys(e ?? {}).sort();

async function save(id: number | null, vars: PhpVars): Promise<{ php: R; ts: R }> {
  const php = await runPhp<R>({ op: "adminsys.filter.save", args: { agent: 1, id, vars } });
  const ts = await tx((t) => saveFilter(t, id, vars));
  if (process.env.DEBUG_DIFF) console.log(JSON.stringify({ php, ts }));
  expect(ts.ok).toBe(php.ok);
  expect(keys(ts.errors)).toEqual(keys(php.errors));
  if (php.ok) expect(ts.id).toBe(php.id);
  return { php, ts };
}

const FILTER: PhpVars = {
  do: "add",
  name: "Spam",
  execorder: "5",
  isactive: "1",
  target: "Any",
  match_all_rules: "0",
  stop_onmatch: "1",
  notes: "<p>Note <script>x</script></p>",
  rules: { "0": { w: "email", h: "contains", v: "@spam" }, "1": { w: "name", h: "match", v: "urgent" }, "2": { w: "addressee", h: "not_match", v: "/x/i" } },
  actions: ["Ndept", "Npri", "Nsla", "Nteam", "Nagent", "Ntopic", "Nstatus", "Ncanned", "Nemail", "Nreject", "Nnoresp", "Nreplyto"],
  dept_id: "2",
  priority: "3",
  sla_id: "1",
  team_id: "1",
  staff_id: "2",
  topic_id: "2",
  status_id: "1",
  canned_id: "1",
  recipients: "a@b.example, %{user}",
  subject: "Oggetto <b>importante</b>",
  message: "<p>Ciao <script>x</script></p>",
  from: "2",
};

describe("filtri: PHP vs TypeScript", () => {
  it("creazione con tutte le azioni e regole (regex avvolta), target email", async () => {
    const r = await save(null, FILTER);
    expect(r.php.ok).toBe(true);
    await save(null, { ...FILTER, name: "Per email", target: "2", actions: ["Nemail", "Nemail"], from: "", isactive: undefined, match_all_rules: "1" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("modifica: azioni esistenti (I), eliminate (D) e nuove; setFlag ×3 ricrea le regole", async () => {
    const r = await save(null, { ...FILTER, actions: ["Ndept", "Npri", "Nemail"] });
    const id = r.php.id!;
    const [dept, pri, email] = [2, 3, 4];
    // l'ultima azione è esistente (I): validate_actions chiama setFlag ×3
    await execBoth(`UPDATE {p}filter SET flags = 7 WHERE id = ${id}`);
    await save(id, { ...FILTER, do: "update", name: "Spam 2", actions: [`D${pri}`, "Nagent", `I${email}`, `I${dept}`], dept_id: "3", staff_id: "3", subject: "Nuovo" });
    // l'ultima azione è nuova: nessun setFlag
    await save(id, { ...FILTER, do: "update", name: "Spam 2", actions: [`I${dept}`, "Nnoresp"], rules: { "0": { w: "email", h: "equal", v: "x@y.example" } } });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("errori: regole, nome, ordine, target, azioni vuote o non valide, nessuna azione", async () => {
    await execBoth("UPDATE {p}department SET flags = 0 WHERE id = 3");
    const cases: PhpVars[] = [
      { ...FILTER, name: "", execorder: "x", target: "" },
      { ...FILTER, name: "SYSTEM BAN LIST", execorder: "", target: "Foo" },
      { ...FILTER, rules: { "0": { w: "email", h: "equal", v: "non-email" }, "1": { w: "foo", h: "equal", v: "a" }, "2": { w: "name", h: "", v: "b" }, "3": { w: "", h: "", v: "c" }, "4": { w: "name", h: "match", v: "/a/zz" } } },
      { ...FILTER, rules: {} },
      { ...FILTER, rules: { "0": { w: "", h: "", v: "" } } },
      { ...FILTER, actions: ["Ndept"], dept_id: "3" },
      { ...FILTER, actions: ["Ntopic"], topic_id: "99" },
      { ...FILTER, actions: ["Npri", "Ndept"], priority: "" },
      { ...FILTER, actions: undefined },
      { ...FILTER, actions: ["Nteam"], team_id: ":new:" },
    ];
    for (const vars of cases) await save(null, vars);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("errore nella configurazione di un'azione email: salvataggio parziale come il PHP", async () => {
    await save(null, { ...FILTER, actions: ["Ndept", "Nemail", "Npri"], recipients: "bad", subject: "" });
    await save(null, { ...FILTER, name: "Altro", actions: ["Nemail"], recipients: "x@y.example", subject: "=SOMMA()" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("azioni di massa: disabilita, abilita, elimina (la ban list resta)", async () => {
    const r = await save(null, FILTER);
    const id = r.php.id!;
    const run = async (a: FilterMassAction, ids: number[]) => {
      const php = await runPhp<R>({ op: "adminsys.filter.mass", args: { agent: 1, a, ids: ids.map(String) } });
      const ts = await tx((t) => massFilters(t, a, ids));
      expect(ts.ok).toBe(php.ok);
      expect(ts.num).toBe(php.num);
    };
    await run("disable", [1, id]);
    await run("enable", [id, 99]);
    await run("delete", [1, id]);
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
