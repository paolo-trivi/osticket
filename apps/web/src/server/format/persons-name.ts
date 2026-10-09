/**
 * Port di PersonsName / AgentsName / UsersName (include/class.user.php): scomposizione del nome e
 * formati configurabili (core.agent_name_format, core.client_name_format).
 */
type NameFormat =
  | "first" | "last" | "full" | "legal" | "lastfirst" | "formal" | "short" | "shortformal" | "complete" | "original";

interface NameParts {
  salutation: string;
  first: string;
  middle: string;
  last: string;
  suffix: string;
}

const FORMATS: NameFormat[] = ["first", "last", "full", "legal", "lastfirst", "formal", "short", "shortformal", "complete", "original"];

function splitName(name: string): NameParts {
  let r = name.split(" ");
  if (r.length === 1 && r[0].includes(".")) r = name.split(".");
  const size = r.length;
  const res: NameParts = { salutation: "", first: "", middle: "", last: "", suffix: "" };
  if (!r[0].includes(".")) res.first = r[0];
  else {
    res.salutation = r[0];
    res.first = r[1] ?? "";
  }
  res.suffix = r[size - 1].includes(".") ? r[size - 1] : "";
  const start = res.salutation ? 2 : 1;
  const end = res.suffix ? size - 2 : size - 1;
  const middle: string[] = [];
  for (let i = start; i <= end; i++) middle.push(r[i] ?? "");
  if (middle.length > 1) {
    res.last = middle.pop() ?? "";
    res.middle = middle.join(" ");
  } else {
    res.last = middle[0] ?? "";
    res.middle = "";
  }
  return res;
}

const initial = (s: string) => (s ? `${[...s][0]}.` : "");

export class PersonsName {
  readonly format: NameFormat;
  readonly parts: NameParts;
  readonly name: string;

  constructor(name: string | { first: string; last: string }, format?: string) {
    this.format = format && (FORMATS as string[]).includes(format) ? (format as NameFormat) : "original";
    if (typeof name === "string") {
      this.parts = splitName(name);
      this.name = name;
    } else {
      this.parts = { salutation: "", middle: "", suffix: "", first: name.first ?? "", last: name.last ?? "" };
      this.name = `${name.first ?? ""} ${name.last ?? ""}`;
    }
  }

  get first() { return this.parts.first; }
  get last() { return this.parts.last; }
  full() { return `${this.parts.first} ${this.parts.last}`.trim(); }
  legal() { return [this.parts.first, initial(this.parts.middle), this.parts.last].filter(Boolean).join(" "); }
  complete() {
    return [this.parts.salutation, this.parts.first, initial(this.parts.middle), this.parts.last, this.parts.suffix].filter(Boolean).join(" ");
  }
  formal() { return `${this.parts.salutation} ${this.parts.last}`.trim(); }
  lastfirst() {
    let n = `${this.parts.last}, ${this.parts.first}`.replace(/^[, ]+|[, ]+$/g, "");
    if (this.parts.suffix) n += `, ${this.parts.suffix}`;
    return n;
  }
  short() { return `${this.parts.first} ${initial(this.parts.last)}`; }
  shortformal() { return `${initial(this.parts.first)} ${this.parts.last}`; }
  original() { return this.name; }
  initials() {
    const names = [this.parts.first, ...this.parts.middle.split(" "), this.parts.last].filter(Boolean);
    return names.map((n) => [...n][0]).join("").toUpperCase();
  }

  /** Variabile di template `%{….name.<formato>}` */
  getVar(tag: string): string | undefined {
    switch (tag) {
      case "first": return this.parts.first;
      case "last": return this.parts.last;
      case "middle": return this.parts.middle;
      case "full": return this.full();
      case "legal": return this.legal();
      case "lastfirst": return this.lastfirst();
      case "formal": return this.formal();
      case "short": return this.short();
      case "shortformal": return this.shortformal();
      case "complete": return this.complete();
      case "original": return this.original();
      case "initials": return this.initials();
      case "firstinitial": return initial(this.parts.first);
      case "lastinitial": return initial(this.parts.last);
      case "middleinitial": return initial(this.parts.middle);
      case "name": return this.toString();
    }
    return undefined;
  }

  /** TemplateVariable: il nome nel formato configurato */
  asVar(): string {
    return this.toString();
  }

  toString(): string {
    return this.getVar(this.format) ?? this.full();
  }
}

export const agentsName = (first: string, last: string, format: string) => new PersonsName({ first, last }, format);
export const usersName = (name: string, format: string) => new PersonsName(name, format);
