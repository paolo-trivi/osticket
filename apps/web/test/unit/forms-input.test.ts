import { describe, expect, it } from "vitest";

import { isUserId } from "@/server/domain/client/identity";
import { fieldChoices, fieldToDatabase, fieldToString, parseField, parseFieldValue, phpCleanValue, type FieldDef } from "@/server/domain/forms/fields";
import { parseAddressList } from "@/server/domain/forms/validator";

/*
 * Lettura dell'input dei form dinamici (FormField::getClean = parse(Widget::getValue)) e lista di
 * indirizzi di Mail_Parse. Valori attesi prodotti da PHP 8.3 con il codice di osTicket (SimpleForm con
 * TextboxField, TextareaField, PhoneField, BooleanField, ChoiceField, DatetimeField; fuso Europe/Rome).
 */

function field(type: string, config: Record<string, unknown> = {}, name = "f"): FieldDef {
  const f: FieldDef = { id: 7, formId: 1, type, label: "F", name, hint: "", flags: 0x3301, sort: 1, config };
  if (type === "choices") f.choices = fieldChoices(f);
  return f;
}

const CHOICES = { choices: "a:Alta\nb:Bassa\n0:Zero", multiselect: false };
const db = (f: FieldDef, source: Record<string, unknown>) => fieldToDatabase(f, parseField(f, source, "Europe/Rome")).value;

describe("parseField: stessi valori del PHP", () => {
  it("testo e memo: tag rimossi, nessun trim", () => {
    expect(parseField(field("text"), { f: "  <b>Ciao</b>  " })).toBe("  Ciao  ");
    expect(parseField(field("memo", { html: false }), { f: "  riga  " })).toBe("  riga  ");
    // assente: il PHP dà "" per il testo, salvato comunque NULL; qui null
    expect(parseField(field("text"), {})).toBeNull();
    expect(parseField(field("text"), { f: null, 7: "per id" })).toBe("per id");
  });

  it("telefono: solo cifre e X, testo originale se non resta nulla, interno \"0\" accodato senza X", () => {
    expect(parseField(field("phone"), { f: "   " })).toBe("   ");
    expect(parseField(field("phone"), { f: " 06 555-1234 " })).toBe("065551234");
    expect(parseField(field("phone"), { f: "0655512", "f-ext": "0" })).toBe("06555120");
    expect(parseField(field("phone"), { f: "0655512", "f-ext": "12" })).toBe("0655512X12");
    expect(parseField(field("phone", {}, ""), { 7: "0655512", "7-ext": "3" })).toBe("0655512X3");
  });

  it("casella: (bool) PHP del valore inviato", () => {
    expect([db(field("bool"), { f: "false" }), db(field("bool"), { f: "0" }), db(field("bool"), { f: "" }), db(field("bool"), { f: [] })]).toEqual(["1", "0", "0", "0"]);
  });

  it("scelte: chiave nota, testo sconosciuto conservato, \"0\" ignorato, JSON ed elenco con virgole", () => {
    const f = field("choices", CHOICES);
    expect(db(f, { f: "a" })).toBe('{"a":"Alta"}');
    expect(db(f, { f: "zzz" })).toBe("zzz");
    expect(fieldToString(f, parseField(f, { f: "zzz" }))).toBe("");
    expect(db(f, { f: "0" })).toBeNull();
    expect(db(f, { f: '{"b":"Bassa"}' })).toBe('{"b":"Bassa"}');
    expect(db(f, { f: "a,b" })).toBe('{"a":"Alta","b":"Bassa"}');
    const multi = field("choices", { choices: "a:Alta\nb:Bassa", multiselect: true });
    expect(db(multi, { f: ["a", "b"] })).toBe('{"a":"Alta","b":"Bassa"}');
    // getClean() riletto come sorgente (User::fromVars): la selezione multipla va persa come nel PHP
    expect(db(multi, { f: { a: "Alta", b: "Bassa" } })).toBeNull();
    expect(db(f, { f: phpCleanValue(f, parseField(f, { f: "b" })) })).toBe('{"b":"Bassa"}');
  });

  it("data: convertita nel fuso dell'utente solo se \"vera\" e interpretabile", () => {
    expect(db(field("datetime"), { f: "0" })).toBe("0");
    expect(db(field("datetime"), { f: "2026-09-30" })).toBe("2026-09-30 02:00:00 CEST");
    expect(db(field("datetime", { time: true }), { f: "2026-01-15 08:30" })).toBe("2026-01-15 09:30:00 CET");
  });

  it("lista: voce per id o per valore (SelectionField::lookupChoice)", () => {
    const f: FieldDef = { ...field("list-2"), choices: { 20: "Radiologia", 21: "Cardiologia" } };
    expect(db(f, { f: "21" })).toBe('{"21":"Cardiologia"}');
    expect(db(f, { f: "Radiologia" })).toBe('{"20":"Radiologia"}');
    expect(db(f, { f: { 21: "Cardiologia" } })).toBe('{"21":"Cardiologia"}');
    expect(db(f, { f: "Sconosciuto" })).toBeNull();
  });

  it("import CSV: FormField::parse senza widget (nessuna conversione della data)", () => {
    expect(fieldToDatabase(field("choices", CHOICES), parseFieldValue(field("choices", CHOICES), "b")).value).toBe('{"b":"Bassa"}');
    expect(parseFieldValue(field("datetime"), " 2026-09-30 ")).toBe("2026-09-30");
  });
});

describe("Validator::is_userid", () => {
  it("un numero esponenziale non è un nome utente (is_numeric)", () => {
    expect([isUserId("1e5"), isUserId("m.rossi"), isUserId("12"), isUserId("a@b.it")]).toEqual([false, true, false, true]);
  });
});

describe("parseAddressList (Mail_Parse: Mail_RFC822 senza validazione degli atomi)", () => {
  // [lista, esito di Mail_RFC822::parseAddressList($s, null, null, false)] calcolati con PHP 8.3
  const CASES: [string, unknown][] = [
    ["a@b.com", [{ personal: "", mailbox: "a", host: "b.com" }]],
    ["Mario Rossi <m.rossi@ospedale.example>, x@y.it", [{ personal: "Mario Rossi", mailbox: "m.rossi", host: "ospedale.example" }, { personal: "", mailbox: "x", host: "y.it" }]],
    ['"Rossi, Mario" <m@x.it>', [{ personal: '"Rossi, Mario"', mailbox: "m", host: "x.it" }]],
    ["%{user}", [{ personal: "", mailbox: "%{user}", host: "localhost" }]],
    ["%{user}, capo@ospedale.example", [{ personal: "", mailbox: "%{user}", host: "localhost" }, { personal: "", mailbox: "capo", host: "ospedale.example" }]],
    ["%{ticket.number}@x.it", [{ personal: "", mailbox: "%{ticket.number}", host: "x.it" }]],
    ["solo", [{ personal: "", mailbox: "solo", host: "localhost" }]],
    ["a@b.com,", [{ personal: "", mailbox: "a", host: "b.com" }]],
    ["Nome &lt;a@b.com&gt;", null],
    ["Gruppo: a@b.it, c@d.it;", [{ personal: "", mailbox: "", host: "", group: true }]],
    ["àè@x.it", [{ personal: "", mailbox: "àè", host: "x.it" }]],
    ["a..b@c.it", null],
    ["<a@b.it>", [{ personal: "", mailbox: "a", host: "b.it" }]],
    ["a@b.it (commento)", [{ personal: "", mailbox: "a", host: "b.it" }]],
    ['"unclosed <a@b.it>', null],
    ["a@b.it, , c@d.it", null],
    ["Mario <m@x.it", null],
    [" ", null],
    ["a@[1.2.3.4]", [{ personal: "", mailbox: "a", host: "[1.2.3.4]" }]],
  ];
  it.each(CASES)("%s", (list, expected) => {
    expect(parseAddressList(list, { validate: false })).toEqual(expected);
  });
});
