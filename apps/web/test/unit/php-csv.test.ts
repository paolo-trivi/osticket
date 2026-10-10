import { describe, expect, it } from "vitest";

import { parseCsv } from "@/server/php/csv";

/**
 * Valori attesi ricavati eseguendo PHP 8.3 (php CLI): righe di fgetcsv($stream, 4096, ",", "\"", "")
 * lette fino a false da un php://temp con il testo del caso.
 */
const CASES: [string, (string | null)[][]][] = [
  ["name, email\nMario Rossi, mario@example.com", [["name", " email"], ["Mario Rossi", " mario@example.com"]]],
  ["a,b\r\nc,d\r\n", [["a", "b"], ["c", "d"]]],
  // "\r" isolato: non chiude la riga
  ["a,b\rc,d", [["a", "b\rc", "d"]]],
  ['"Rossi, Mario",mario@example.com\n', [["Rossi, Mario", "mario@example.com"]]],
  ['"He said ""hi""",x', [['He said "hi"', "x"]]],
  ['"multi\nline",y\n', [["multi\nline", "y"]]],
  ["a,,c\n", [["a", "", "c"]]],
  // riga vuota → [null]
  ["a,b\n\nc,d\n", [["a", "b"], [null], ["c", "d"]]],
  ["", []],
  ["\n", [[null]]],
  [",", [["", ""]]],
  ['x,""', [["x", ""]]],
  ["àèì,ü\n", [["àèì", "ü"]]],
  ["a\n\n\nb", [["a"], [null], [null], ["b"]]],
  // spazi iniziali saltati solo davanti alle virgolette
  ['  "a",b', [["a", "b"]]],
  [" a , b \n", [[" a ", " b "]]],
  ['\t"q",r', [["q", "r"]]],
  ['a, "b",c', [["a", "b", "c"]]],
  // testo dopo la virgoletta di chiusura
  ['"abc"def,g', [["abcdef", "g"]]],
  ['"a" ,b', [["a ", "b"]]],
  ['"a"x\r\n', [["ax"]]],
  ['a,"b"  \n', [["a", "b  "]]],
  // virgolette non chiuse: tutto fino alla fine del testo
  ['"unterminated,x\ny', [["unterminated,x\ny"]]],
  ['"abc', [["abc"]]],
  ['x,"abc', [["x", "abc"]]],
  ['"abc\n', [["abc\n"]]],
  ['"abc\r\n', [["abc\r\n"]]],
  ['a,b\n"abc\ndef', [["a", "b"], ["abc\ndef"]]],
  // virgolette letterali in un campo senza virgolette
  ['ab"cd,e', [['ab"cd', "e"]]],
  ['a"b"c', [['a"b"c']]],
  // terminazioni: una sola tolta dalla riga, una dal campo senza virgolette
  ["a,b\r\n", [["a", "b"]]],
  ["a,b\r", [["a", "b"]]],
  ["a,b\r\r", [["a", "b"]]],
  ["a\r\r\nb", [["a"], ["b"]]],
  ['"x\r\ny",z', [["x\r\ny", "z"]]],
  ['a,"b"\r\nc', [["a", "b"], ["c"]]],
  ['"a\nb"c\nd', [["a\nbc"], ["d"]]],
  ['"a"""\n', [['a"']]],
  ['"a""","""b"\n', [['a"', '"b']]],
  ['""""', [['"']]],
];

describe("parseCsv (fgetcsv di PHP)", () => {
  it.each(CASES)("%j", (text, expected) => {
    expect(parseCsv(text)).toEqual(expected);
  });
});
