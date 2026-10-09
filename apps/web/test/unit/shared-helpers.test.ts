import { describe, expect, it } from "vitest";

import { safeColor } from "@/lib/color";
import { inlineCidImages } from "@/lib/format/inline-images";
import { humanSize } from "@/lib/format/size";
import { formFlag, formHtml, formIds, formNum, formStr, formStrs } from "@/server/actions/form-data";

describe("humanSize", () => {
  it("byte, KB e MB con un decimale", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(1023)).toBe("1023 B");
    expect(humanSize(1024)).toBe("1.0 KB");
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(1024 * 1024 - 1)).toBe("1024.0 KB");
    expect(humanSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("safeColor", () => {
  it("accetta solo esadecimali #rgb/#rrggbb", () => {
    expect(safeColor("#FEE7E7")).toBe("#FEE7E7");
    expect(safeColor("#abc")).toBe("#abc");
    expect(safeColor("#abcd")).toBeNull();
    expect(safeColor("red;background:url(x)")).toBeNull();
    expect(safeColor("")).toBeNull();
    expect(safeColor(null)).toBeNull();
    expect(safeColor(undefined)).toBeNull();
  });
});

describe("inlineCidImages", () => {
  it("riscrive le immagini cid: verso la route protetta dell'area", () => {
    expect(inlineCidImages('<img src="cid:abc_1-2">', "agent")).toBe('<img src="/api/agent/file/abc_1-2?disposition=inline">');
    expect(inlineCidImages('<img src="cid:k">', "portal")).toBe('<img src="/api/portal/file/k?disposition=inline">');
    expect(inlineCidImages('<img src="https://x/y.png">', "agent")).toBe('<img src="https://x/y.png">');
  });
});

function form(entries: [string, string][]): FormData {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

describe("helper FormData delle server action", () => {
  const fd = form([
    ["name", "Mario"],
    ["n", "42"],
    ["bad", "x"],
    ["on", "1"],
    ["off", "0"],
    ["ids", "3"],
    ["ids", "0"],
    ["ids", "-1"],
    ["ids", "abc"],
    ["ids", "7"],
    ["files", "a"],
    ["files", ""],
    ["empty", "<p>&nbsp;</p> "],
    ["comments", "<p>ciao</p>"],
  ]);

  it("formStr: stringa o valore di riserva", () => {
    expect(formStr(fd, "name")).toBe("Mario");
    expect(formStr(fd, "missing")).toBe("");
    expect(formStr(fd, "missing", "all")).toBe("all");
  });
  it("formNum: numero, 0 se assente, NaN se non numerico", () => {
    expect(formNum(fd, "n")).toBe(42);
    expect(formNum(fd, "missing")).toBe(0);
    expect(formNum(fd, "bad")).toBeNaN();
  });
  it("formFlag: vero solo con valore 1", () => {
    expect(formFlag(fd, "on")).toBe(true);
    expect(formFlag(fd, "off")).toBe(false);
    expect(formFlag(fd, "missing")).toBe(false);
  });
  it("formStrs e formIds: campi ripetuti", () => {
    expect(formStrs(fd, "files")).toEqual(["a", ""]);
    expect(formStrs(fd, "missing")).toEqual([]);
    expect(formIds(fd, "ids")).toEqual([3, 7]);
  });
  it("formHtml: vuoto se ci sono solo tag e spazi", () => {
    expect(formHtml(fd, "empty")).toBe("");
    expect(formHtml(fd, "missing")).toBe("");
    expect(formHtml(fd)).toContain("ciao");
    expect(formHtml(fd, "comments", { sanitize: false })).toBe("<p>ciao</p>");
  });
});
