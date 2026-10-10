import { describe, expect, it } from "vitest";

import { safeHtml } from "@/server/format/sanitize";

describe("safeHtml (Format::safe_html)", () => {
  it("toglie script, eventi e attributi vietati", () => {
    const out = safeHtml('<p id="x" onclick="evil()" data-x="1">ciao<script>alert(1)</script></p>');
    expect(out).toBe("<p>ciao</p>");
  });

  it("decodifica le entità prima di pulire (niente bypass con &lt;script&gt;)", () => {
    expect(safeHtml("&lt;script&gt;alert(1)&lt;/script&gt;<b>ok</b>")).toBe("<b>ok</b>");
  });

  it("blocca schemi javascript: e mantiene cid: per le immagini inline", () => {
    expect(safeHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(safeHtml('<img src="cid:abc123" />')).toBe('<img src="cid:abc123" alt="image" />');
  });

  it("pulisce stili e classi come __html_cleanup", () => {
    expect(safeHtml('<span class="MsoNormal foo" style="color:red;mso-x:1;background:url(x)">t</span>')).toBe(
      '<span class="MsoNormal" style="color:red">t</span>',
    );
  });

  it("elimina form e iframe non consentiti", () => {
    expect(safeHtml('<form action="/x"><input name="a"></form><iframe src="https://evil.com/x"></iframe>ok')).toBe("ok");
    expect(safeHtml('<iframe src="https://www.youtube.com/embed/x"></iframe>', { iframeWhitelist: ["youtube.com"] })).toContain("<iframe");
  });
});

// Attributi obbligatori di htmLawed: valori attesi prodotti da Format::safe_html (PHP 8.3)
describe("safeHtml: attributi obbligatori come htmLawed", () => {
  it.each([
    ['<p><img src="x"></p>', '<p><img src="x" alt="image" /></p>'],
    ['<img src="cid:abc" alt="">', '<img src="cid:abc" alt="" />'],
    ['<img alt="a">', '<img alt="a" src="src" />'],
    ["<bdo>t</bdo>", '<bdo dir="ltr">t</bdo>'],
    ['<p>a<img src="y.png" width="10"/>b</p>', '<p>a<img src="y.png" width="10" alt="image" />b</p>'],
  ])("%s", (input, expected) => {
    expect(safeHtml(input)).toBe(expected);
  });
});

// Differenza voluta (doc 17 §3): la regex di Format::safe_html è sensibile a maiuscole e spazi
describe("safeHtml: niente posizionamenti CSS (sovrapposizioni all'interfaccia)", () => {
  it.each([
    "POSITION:fixed",
    "position :fixed",
    "Position: Absolute",
    "posi/**/tion:fixed",
    "/*;*/position:fixed",
    "\\70 osition:fixed",
    "\\000070osition:fixed",
    "p\\osition:sticky",
    "position:-webkit-sticky",
  ])("%s", (decl) => {
    const out = safeHtml(`<div style="${decl};top:0;color:red">x</div>`);
    expect(out).not.toMatch(/osition/i);
    expect(out).toContain("color:red");
  });

  it("le altre proprietà restano invariate", () => {
    expect(safeHtml('<span style="color:red;font-weight:bold">t</span>')).toBe('<span style="color:red;font-weight:bold">t</span>');
  });
});
