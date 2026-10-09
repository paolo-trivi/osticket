import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db, type Tx } from "@/server/db";
import type { PhpVars } from "@/server/domain/admin/php";
import { addBanRule, massBanRules, updateBanRule, type BanMassAction } from "@/server/domain/adminsys/banlist";
import { updateEmailsSettings } from "@/server/domain/adminsys/email-settings";

import { compareWorkingDatabases, execBoth, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";

/** Impostazioni email (scp/emailsettings.php) e ban list (scp/banlist.php): PHP vs TypeScript. */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

type R = { ok: boolean; id?: number | null; num?: number; errors?: Record<string, string> };
const tx = <T>(fn: (t: Tx) => Promise<T>) => db().transaction().execute(fn);
const keys = (e?: Record<string, string>) => Object.keys(e ?? {}).sort();

const SETTINGS: PhpVars = {
  t: "emails",
  default_template_id: "1",
  default_email_id: "1",
  alert_email_id: "2",
  admin_email: "admin@example.com",
  strip_quoted_reply: "on",
  reply_separator: "-- reply above this line --",
  default_smtp_id: "0",
  email_attachments: "on",
};

describe("impostazioni email: PHP vs TypeScript", () => {
  it("salvataggio: chiavi nuove (INSERT), modificate e invariate", async () => {
    const vars: PhpVars = {
      ...SETTINGS,
      alert_email_id: "3",
      admin_email: "root@example.org",
      verify_email_addrs: "on",
      enable_auto_cron: "on",
      use_email_priority: "1",
      accept_unregistered_email: "on",
      reply_separator: "--- rispondi sopra ---",
    };
    const php = await runPhp<R>({ op: "adminsys.settings.emails", args: { vars } });
    const ts = await tx((t) => updateEmailsSettings(t, vars));
    expect(php.ok).toBe(true);
    expect(ts.ok).toBe(true);
    // secondo salvataggio senza alcune opzioni (diventano 0) e senza default_smtp_id
    const second: PhpVars = { ...SETTINGS, default_smtp_id: undefined, email_attachments: undefined };
    const php2 = await runPhp<R>({ op: "adminsys.settings.emails", args: { vars: second } });
    const ts2 = await tx((t) => updateEmailsSettings(t, second));
    expect(ts2.ok).toBe(php2.ok);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("errori: separatore mancante, email admin di sistema o non valida, campi obbligatori", async () => {
    const cases: PhpVars[] = [
      { ...SETTINGS, reply_separator: "  " },
      { ...SETTINGS, admin_email: "support@example.com" },
      { ...SETTINGS, admin_email: "non-valida" },
      { ...SETTINGS, default_template_id: undefined, alert_email_id: "" },
      { ...SETTINGS, default_email_id: "abc" },
    ];
    for (const vars of cases) {
      const php = await runPhp<R>({ op: "adminsys.settings.emails", args: { vars } });
      const ts = await tx((t) => updateEmailsSettings(t, vars));
      expect(php.ok).toBe(false);
      expect(ts.ok).toBe(false);
      expect(keys(ts.errors)).toEqual(keys(php.errors));
    }
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

describe("ban list: PHP vs TypeScript", () => {
  const both = async (vars: PhpVars, ts: (t: Tx) => Promise<R>, id?: number) => {
    const php = await runPhp<R>({ op: "adminsys.banlist", args: { id, vars } });
    const r = await tx(ts);
    expect(r.ok).toBe(php.ok);
    expect(keys(r.errors)).toEqual(keys(php.errors));
    return { php, ts: r };
  };

  it("aggiunta, modifica, duplicato e indirizzo non valido", async () => {
    const add = { do: "add", val: " spam@bad.example ", isactive: "1", notes: "<p>Spam<script>x</script></p>" };
    const r = await both(add, (t) => addBanRule(t, add));
    expect(r.ts.ok).toBe(true);
    const dis = { do: "add", val: "other@bad.example", isactive: "0", notes: "" };
    await both(dis, (t) => addBanRule(t, dis));
    await both({ do: "add", val: "spam@bad.example", isactive: "1", notes: "" }, (t) => addBanRule(t, { do: "add", val: "spam@bad.example", isactive: "1", notes: "" }));
    await both({ do: "add", val: "nope", isactive: "1" }, (t) => addBanRule(t, { do: "add", val: "nope", isactive: "1" }));
    // modifica della regola esistente (id 1, test@example.com)
    const upd = { do: "update", val: "test2@example.com", isactive: "0", notes: "Aggiornata" };
    await both(upd, (t) => updateBanRule(t, 1, upd), 1);
    const same = { do: "update", val: "test2@example.com", isactive: "0", notes: "Aggiornata" };
    await both(same, (t) => updateBanRule(t, 1, same), 1);
    await both({ do: "update", val: "x", isactive: "1" }, (t) => updateBanRule(t, 1, { do: "update", val: "x", isactive: "1" }), 1);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("indirizzi validi solo per Validator::is_email (RFC 822) o solo per le vecchie regex", async () => {
    // accettati dal PHP: dominio senza punto, "Nome <indirizzo>", host LOCALHOST maiuscolo, virgola finale
    for (const val of ["user@intranet", "Spam Bot <bot@bad.example>", "x@LOCALHOST", "list@bad.example,"]) {
      const vars = { do: "add", val, isactive: "1", notes: "" };
      const r = await both(vars, (t) => addBanRule(t, vars));
      expect(r.ts.ok).toBe(true);
    }
    // rifiutati dal PHP: punti consecutivi, carattere non ASCII, due indirizzi
    for (const val of ["a..b@bad.example", "àb@bad.example", "a@bad.example, b@bad.example"]) {
      const vars = { do: "add", val, isactive: "1", notes: "" };
      const r = await both(vars, (t) => addBanRule(t, vars));
      expect(r.ts.ok).toBe(false);
    }
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("azioni di massa: disabilita, abilita, elimina (solo regole della ban list)", async () => {
    await execBoth(
      "INSERT INTO {p}filter_rule (filter_id, what, how, val, isactive, notes, created, updated) VALUES (1, 'email', 'equal', 'a@x.example', 1, '', NOW(), NOW()), (1, 'email', 'equal', 'b@x.example', 0, '', NOW(), NOW())",
      "INSERT INTO {p}filter (id, name, target, created, updated) VALUES (5, 'Altro', 'Any', NOW(), NOW())",
      "INSERT INTO {p}filter_rule (id, filter_id, what, how, val, isactive, notes, created, updated) VALUES (50, 5, 'email', 'equal', 'c@x.example', 1, '', NOW(), NOW())",
    );
    const run = async (a: BanMassAction, ids: number[]) => {
      const vars = { do: "mass_process", a, ids: ids.map(String) };
      const php = await runPhp<R>({ op: "adminsys.banlist", args: { vars } });
      const ts = await tx((t) => massBanRules(t, a, ids));
      expect(ts.ok).toBe(php.ok);
      expect(ts.num).toBe(php.num);
    };
    await run("disable", [1, 2, 50]);
    await run("enable", [3]);
    await run("enable", [3]);
    await run("delete", [2, 50]);
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
