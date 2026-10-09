import { describe, expect, it } from "vitest";

import { at, htmlchars, htmlcharsVars, inArray, intval, isArray, isNumeric, isset, list, phpLooseEquals, str, truthy, type PhpVal } from "@/server/php/values";

// Valori attesi prodotti da PHP 8.3 (php -r): (bool) $v, (string) $v, is_numeric($v), (int) $v.
// empty($v) coincide con !(bool) $v per una variabile definita.
const CASES: [string, PhpVal, boolean, string, boolean, number][] = [
  ['""', "", false, "", false, 0],
  ['"0"', "0", false, "0", true, 0],
  ['"0.0"', "0.0", true, "0.0", true, 0],
  ['"00"', "00", true, "00", true, 0],
  ['" 0"', " 0", true, " 0", true, 0],
  ['"0 "', "0 ", true, "0 ", true, 0],
  ['" -0"', " -0", true, " -0", true, 0],
  ['" "', " ", true, " ", false, 0],
  ['"a"', "a", true, "a", false, 0],
  ['"12abc"', "12abc", true, "12abc", false, 12],
  ['"12 a"', "12 a", true, "12 a", false, 12],
  ['" 12"', " 12", true, " 12", true, 12],
  ['"12 "', "12 ", true, "12 ", true, 12],
  ['" 12 "', " 12 ", true, " 12 ", true, 12],
  ["spazi \\t\\n\\r\\v\\f", "\t\n12\r\v\f", true, "\t\n12\r\v\f", true, 12],
  ["NBSP iniziale", " 12", true, " 12", false, 0],
  ['"1e3"', "1e3", true, "1e3", true, 1000],
  ['"1E3"', "1E3", true, "1E3", true, 1000],
  ['"1e3x"', "1e3x", true, "1e3x", false, 1000],
  ['"1e"', "1e", true, "1e", false, 1],
  ['"1.5e3"', "1.5e3", true, "1.5e3", true, 1500],
  ['".5e1"', ".5e1", true, ".5e1", true, 5],
  ['"5.e1"', "5.e1", true, "5.e1", true, 50],
  ['"1e-5"', "1e-5", true, "1e-5", true, 0],
  ['"1e400"', "1e400", true, "1e400", true, 0],
  ['"-1e400"', "-1e400", true, "-1e400", true, 0],
  ['"1."', "1.", true, "1.", true, 1],
  ['".5"', ".5", true, ".5", true, 0],
  ['"."', ".", true, ".", false, 0],
  ['"+.5"', "+.5", true, "+.5", true, 0],
  ['"-3.9"', "-3.9", true, "-3.9", true, -3],
  ['"+7"', "+7", true, "+7", true, 7],
  ['"-"', "-", true, "-", false, 0],
  ['"+"', "+", true, "+", false, 0],
  ['"0x1A"', "0x1A", true, "0x1A", false, 0],
  ['"1_000"', "1_000", true, "1_000", false, 1],
  ['"1,5"', "1,5", true, "1,5", false, 1],
  ['"inf"', "inf", true, "inf", false, 0],
  ['"NAN"', "NAN", true, "NAN", false, 0],
  ['"true"', "true", true, "true", false, 0],
  ['"false"', "false", true, "false", false, 0],
  ["null", null, false, "", false, 0],
  ["undefined (chiave assente)", undefined, false, "", false, 0],
  ["true", true, true, "1", false, 1],
  ["false", false, false, "", false, 0],
  ["0", 0, false, "0", true, 0],
  ["1", 1, true, "1", true, 1],
  ["-1", -1, true, "-1", true, -1],
  ["-0.0", -0.0, false, "-0", true, 0],
  ["1.5", 1.5, true, "1.5", true, 1],
  ["-2.7", -2.7, true, "-2.7", true, -2],
  ["0.1+0.2", 0.1 + 0.2, true, "0.3", true, 0],
  ["1/3", 1 / 3, true, "0.33333333333333", true, 0],
  ["123456.789", 123456.789, true, "123456.789", true, 123456],
  ["0.0001", 0.0001, true, "0.0001", true, 0],
  ["1.0E-5", 1e-5, true, "1.0E-5", true, 0],
  ["-1.5E-7", -1.5e-7, true, "-1.5E-7", true, 0],
  ["NAN", NaN, true, "NAN", true, 0],
  ["INF", Infinity, true, "INF", true, 0],
  ["-INF", -Infinity, true, "-INF", true, 0],
  ["[]", [], false, "Array", false, 0],
  ["[0]", [0], true, "Array", false, 1],
  ['[""]', [""], true, "Array", false, 1],
  ['["a" => 1]', { a: 1 }, true, "Array", false, 1],
  ["mappa vuota", {}, false, "Array", false, 0],
];

describe("semantica PHP 8 dei valori", () => {
  it.each(CASES)("%s", (_label, v, isTrue, s, numeric, int) => {
    expect(truthy(v)).toBe(isTrue);
    expect(str(v)).toBe(s);
    expect(isNumeric(v)).toBe(numeric);
    expect(intval(v)).toBe(int);
  });

  it("float grandi in notazione esponenziale (precision=14); gli interi sicuri restano interi", () => {
    expect([str(1e20), str(1e100), str(-1e21)]).toEqual(["1.0E+20", "1.0E+100", "-1.0E+21"]);
    expect([str(123456789), str(Number.MAX_SAFE_INTEGER)]).toEqual(["123456789", "9007199254740991"]);
  });

  it("isset, is_array, liste e accesso alle mappe", () => {
    expect([isset({ a: "" }, "a"), isset({ a: "0" }, "a"), isset({ a: null }, "a"), isset({}, "a"), isset(null, "a")]).toEqual([true, true, false, false, false]);
    expect([isArray([]), isArray({}), isArray("a"), isArray(null), isArray(new Date())]).toEqual([true, true, false, false, false]);
    expect(list({ 3: "x", 7: "y" })).toEqual(["x", "y"]);
    expect([list("x"), list(null)]).toEqual([[], []]);
    expect([at({ 3: "x" }, 3), at(["a", "b"], "1"), at("abc", 0)]).toEqual(["x", "b", undefined]);
  });
});

// [$a, $b, $a == $b] verificati con PHP 8.3
const LOOSE: [PhpVal, PhpVal, boolean][] = [
  [null, "", true],
  [null, 0, true],
  [null, "0", false],
  [null, " ", false],
  [null, [], true],
  [null, false, true],
  [undefined, null, true],
  ["abc", 0, false],
  [0, "a", false],
  ["0", false, true],
  ["", false, true],
  ["0.0", false, false],
  ["1", true, true],
  ["a", true, true],
  [true, "0", false],
  [" 1", 1, true],
  ["1 ", 1, true],
  [" 1", "1", true],
  ["1e3", "1000", true],
  ["10", "1e1", true],
  ["1.0", "1", true],
  ["1", "01", true],
  [100, "1e2", true],
  ["0.0", "0", true],
  ["abc", "ABC", false],
  ["abc", "abc ", false],
  [0, "", false],
  [0, "0", true],
  ["0", "", false],
  [1, "1abc", false],
  ["0x1A", 26, false],
  [" 1", 1, false],
  [0.1 + 0.2, "0.3", false],
  [1.5, "1.5", true],
  [[], false, true],
  [false, [], true],
  [[], 0, false],
  [[], "", false],
  [[1], true, true],
  [[1, 2], ["1", "2"], true],
  [[1, 2], [2, 1], false],
  [{ a: 1, b: 2 }, { b: 2, a: 1 }, true],
  [[1], [1, 2], false],
  [[], [], true],
  [[0], [false], true],
];

describe("confronto debole == di PHP 8", () => {
  it.each(LOOSE)("%j == %j", (a, b, expected) => {
    expect(phpLooseEquals(a, b)).toBe(expected);
    expect(phpLooseEquals(b, a)).toBe(expected);
  });

  it("in_array debole", () => {
    expect([inArray("1", [0, 1]), inArray("a", [0]), inArray(null, [""]), inArray("x", "x")]).toEqual([true, false, true, false]);
  });
});

describe("Format::htmlchars", () => {
  it("scalari come htmlspecialchars((string) $v, ENT_COMPAT | ENT_HTML401, 'UTF-8', false)", () => {
    expect(htmlchars(`a & b <c> "d" 'e' &amp; &#39;`)).toBe(`a &amp; b &lt;c&gt; &quot;d&quot; 'e' &amp; &#39;`);
    // entità sconosciute o fuori intervallo vengono ricodificate
    expect([htmlchars("&foo;"), htmlchars("&#1114112;"), htmlchars("&nbsp;")]).toEqual(["&amp;foo;", "&amp;#1114112;", "&nbsp;"]);
    expect([htmlchars(null), htmlchars(true), htmlchars(false), htmlchars(1.5)]).toEqual(["", "1", "", "1.5"]);
  });

  it("ricorsivo sugli array, con sanitize opzionale; le chiavi assenti restano assenti", () => {
    expect(htmlchars({ a: ["<x>", { b: "&" }] })).toEqual({ a: ["&lt;x&gt;", { b: "&amp;" }] });
    expect(htmlchars("<script>alert(1)</script>ok", true)).toBe("ok");
    expect(htmlcharsVars({ t: "<b>", n: null, u: undefined, l: ["<i>"] })).toEqual({ t: "&lt;b&gt;", n: null, u: undefined, l: ["&lt;i&gt;"] });
    expect(htmlcharsVars({ t: "<b>x</b>" }, true)).toEqual({ t: "&lt;b&gt;x&lt;/b&gt;" });
  });
});
