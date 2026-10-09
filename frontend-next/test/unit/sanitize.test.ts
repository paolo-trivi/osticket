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
    expect(safeHtml('<img src="cid:abc123" />')).toBe('<img src="cid:abc123" />');
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
