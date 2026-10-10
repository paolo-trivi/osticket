import { describe, expect, it } from "vitest";

import { fieldChoices, type FieldDef } from "@/server/domain/forms/fields";
import { isEmail, isIp, isPhone, isValidEmail, phpIsNumeric } from "@/server/domain/forms/validator";

/*
 * Valori attesi prodotti da PHP 8.3 con il codice di osTicket: Validator::is_email (Mail_RFC822 di
 * include/pear), Validator::is_phone, Validator::is_ip, is_numeric e ChoiceField::getChoices.
 */

// [indirizzo, is_email]. Le due regex sostituite davano esiti diversi fra loro e dal PHP, ad es.:
// "a@b" e "a@[1.2.3.4]" (rifiutati dalla regex di directory), "a@b_c.com" e "a@-b.com" (rifiutati
// da quella di forms), "a..b@c.com", "a@b..com" e "àb@c.com" (accettati da directory), "Name <a@b.com>"
// e "a@LOCALHOST" (rifiutati da entrambe).
const EMAILS: [string, boolean][] = [
  ["a@b.com", true],
  ["a@b", true],
  ["user@intranet", true],
  ["Name <a@b.com>", true],
  ['"John Doe" <a@b.com>', true],
  ["John Doe <a@b.com>", true],
  ["J. Doe <a@b.com>", false],
  ["a@b_c.com", true],
  ["a@-b.com", true],
  ["a@LOCALHOST", true],
  ["a@localhost", false],
  ["localuser", false],
  ["a..b@c.com", false],
  [".a@c.com", false],
  ["a.@c.com", false],
  ["a@b..com", false],
  ["a@b.com.", false],
  ["a@[1.2.3.4]", true],
  ["a@[1.2.3.4", false],
  ["a/b@c.com", true],
  ["a@b.com (comment)", true],
  ["(c) a@b.com", true],
  ["àb@c.com", false],
  ["a@bà.com", false],
  ["a@b.com,", true],
  ["a@b.com, c@d.com", false],
  ["a@b.com,0", true],
  ["g: a@b.com;", false],
  ['"a@b"@c.com', true],
  ['"a b"@c.com', true],
  ["a b@c.com", false],
  ["0@b.com", false],
  ["00@b.com", true],
  ["a@ localhost", true],
  ["<a@b.com>", true],
  ["<a@b.com", false],
  ["a@b.com>", false],
  ["@b.com", false],
  ["a@", false],
  ["", false],
  ["   ", false],
  ["a@b@c.com", false],
  ['a"b@c.com', false],
  ["a\\b@c.com", true],
  ["a@b.com\r\n x", false],
  ["a+tag@example.co.uk", true],
  ["first.last@example.com", true],
  ["x@y.z", true],
  ["a@@b.com", false],
  ["a@b,c.com", false],
  ["a@b;c.com", false],
  ["<@route.com:a@b.com>", false],
  ["Name <@route.com:a@b.com>", true],
  ["a@1.2.3.4", true],
  ["a(b)c@d.com", true],
  ["a@b.c(m)", true],
  ['""@b.com', true],
  ["a@[1.2]3]", false],
  ["Name<a@b.com>", true],
  ['a."b"@c.com', true],
  ["a@b .com", true],
  [" a@b.com ", true],
  ["a@b.com\n", true],
  ["test@exa mple.com", false],
  ["a@b\tc.com", false],
  ["é@é.com", false],
  ['"é"@x.com', true],
  ["a@b.com,,", false],
  ["a@b.com ,", true],
  ["x@y.com;", false],
  ["a@b.com (x (y) z)", true],
  ["a@b.com (unclosed", false],
  ["a@b.com)", false],
  ['"unclosed@b.com', false],
  ["a.b.c@d.e.f", true],
  ["a@b.c-d.e", true],
  ["1234567@example.com", true],
  ["a@b.com, ", true],
  ["a@b.com,  0", true],
];

describe("isEmail = Validator::is_email", () => {
  it.each(EMAILS)("%j", (email, expected) => {
    expect(isEmail(email)).toBe(expected);
  });

  it("isValidEmail senza verifica DNS coincide con isEmail", async () => {
    for (const [email, expected] of EMAILS) expect(await isValidEmail(email, false)).toBe(expected);
  });
});

const PHONES: [string, boolean][] = [
  ["555-1234", true],
  ["(555) 123-4567", true],
  ["+39 06 1234 5678", true],
  ["123456", false],
  ["12345678901234567", false],
  ["555 1234x", false],
  // lo spazio non separabile non è tolto dal PHP (la classe contiene due spazi normali)
  ["555 1234", false],
  ["1.5e3456", true],
  [" 5551234", true],
  ["5551234\n", true],
  [" 5551234", false],
  ["abc", false],
  ["12345678901234.5", true],
];

describe("isPhone = Validator::is_phone", () => {
  it.each(PHONES)("%j", (phone, expected) => {
    expect(isPhone(phone)).toBe(expected);
  });
});

const IPS: [string, boolean][] = [
  ["1.2.3.4", true],
  [" 10.0.0.1 ", true],
  ["999.1.1.1", false],
  ["01.2.3.4", false],
  ["1.2.3", false],
  ["abc", false],
  ["dead", false],
  ["::1", true],
  ["::ffff:1.2.3.4", true],
  ["fe80::1%eth0", false],
  ["2001:db8::1", true],
  ["1.2.3.4.5", false],
  ["", false],
  ["1:2:3:4:5:6:7:8:9", false],
];

describe("isIp = Validator::is_ip", () => {
  it.each(IPS)("%j", (ip, expected) => {
    expect(isIp(ip)).toBe(expected);
  });
});

const NUMBERS: [string, boolean][] = [
  ["12", true],
  [" 12", true],
  ["12 ", true],
  [" 12", false],
  ["1e5", true],
  [".5", true],
  ["5.", true],
  ["+1", true],
  ["-1", true],
  ["0x1A", false],
  ["", false],
  [" ", false],
  ["1 2", false],
  ["\t3\n", true],
  ["\v4", true],
];

describe("phpIsNumeric = is_numeric", () => {
  it.each(NUMBERS)("%j", (v, expected) => {
    expect(phpIsNumeric(v)).toBe(expected);
  });
});

describe("fieldChoices = ChoiceField::getChoices", () => {
  const field = (choices: unknown): FieldDef => ({ id: 1, formId: 1, type: "choices", label: "", name: "c", hint: "", flags: 0, sort: 1, config: { choices } });

  it("righe chiave:etichetta come explode(':', $choice, 2) + trim", () => {
    expect(fieldChoices(field("a:Alpha\nb\nc:\nd: \n\ne:0\n f : Foo:Bar \r\ng:G\r"))).toEqual({
      a: "Alpha",
      b: "b",
      c: "c",
      d: "",
      "": "",
      e: "0",
      f: "Foo:Bar",
      g: "G",
    });
  });

  it("scelte già risolte o configurazione già decodificata", () => {
    expect(fieldChoices({ ...field("x:X"), choices: { 1: "Uno" } })).toEqual({ 1: "Uno" });
    expect(fieldChoices(field({ k: "K" }))).toEqual({ k: "K" });
  });
});
