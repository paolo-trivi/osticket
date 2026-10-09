import { describe, expect, it } from "vitest";

import { htmlChars } from "@/server/format/html";

// Valori attesi prodotti da PHP 8.3: htmlspecialchars($s, ENT_COMPAT | ENT_HTML401, 'UTF-8', false)
const CASES: [string, string][] = [
  ["a & b", "a &amp; b"],
  ["&amp; ok", "&amp; ok"],
  ["&nbsp;x", "&nbsp;x"],
  ["&foo; y", "&amp;foo; y"],
  ["&#39; z", "&#39; z"],
  ["&#x27; w", "&#x27; w"],
  ["&#0; q", "&#0; q"],
  ["l'acqua \"x\" <b>", "l'acqua &quot;x&quot; &lt;b&gt;"],
  ["&Amp;", "&amp;Amp;"],
  ["&#1114112;", "&amp;#1114112;"],
  ["&#xD800;", "&#xD800;"],
  ["&#48", "&amp;#48"],
];

describe("htmlChars = Format::htmlchars", () => {
  it.each(CASES)("%s", (input, expected) => {
    expect(htmlChars(input)).toBe(expected);
  });
});
