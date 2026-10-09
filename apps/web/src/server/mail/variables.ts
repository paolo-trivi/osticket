/**
 * Port di VariableReplacer (include/class.variable.php): sostituzione di `%{oggetto.attributo…}` e della
 * forma URL-encoded `%%7B…%7D` nei template email e nelle risposte predefinite.
 *
 * Risoluzione di ogni segmento come il PHP: getVar(tag) dell'oggetto, poi attributo; un oggetto finale
 * viene convertito con asVar(). Variabili sconosciute restano nel testo così come sono.
 */
export interface TemplateVariable {
  getVar(tag: string, replacer: VariableReplacer): unknown;
  asVar(replacer: VariableReplacer): string;
}

function isTemplateVariable(v: unknown): v is TemplateVariable {
  return typeof v === "object" && v !== null && typeof (v as TemplateVariable).getVar === "function" && typeof (v as TemplateVariable).asVar === "function";
}

/** Oggetto semplice esposto ai template (stile array PHP, con attributi). */
export class VarBag implements TemplateVariable {
  constructor(
    private readonly values: Record<string, unknown>,
    private readonly asString: string | (() => string) = "",
  ) {}
  getVar(tag: string): unknown {
    const v = this.values[tag];
    return typeof v === "function" ? (v as () => unknown)() : v;
  }
  asVar(): string {
    return typeof this.asString === "function" ? this.asString() : this.asString;
  }
}

const BLACKLIST = new Set(["passwd", "password", "authkey"]);

function phpString(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v === true) return "1";
  return String(v);
}

export class VariableReplacer {
  private readonly objects = new Map<string, unknown>();
  private readonly variables = new Map<string, unknown>();

  assign(vars: Record<string, unknown>): this {
    for (const [k, v] of Object.entries(vars)) {
      if (v && typeof v === "object") this.objects.set(k, v);
      else this.variables.set(k, v);
    }
    return this;
  }

  getObj(tag: string): unknown {
    return this.objects.get(tag);
  }

  getVar(obj: unknown, varName: string | undefined): unknown {
    if (!obj) return "";
    const dot = varName ? varName.indexOf(".") : -1;
    const rawTag = varName ? (dot >= 0 ? varName.slice(0, dot) : varName) : "";
    const remainder = dot >= 0 && varName ? varName.slice(dot + 1) : "";
    const tag = rawTag.toLowerCase();
    if (BLACKLIST.has(tag)) return "";

    let rv: unknown;
    if (isTemplateVariable(obj)) {
      if (!varName) return obj.asVar(this);
      rv = obj.getVar(tag, this);
    } else if (typeof obj === "object" && !Array.isArray(obj)) {
      const rec = obj as Record<string, unknown>;
      if (tag && tag in rec) rv = rec[tag];
      else return "";
    } else {
      return "";
    }
    if ((rv && typeof rv === "object") || remainder) return this.getVar(rv, remainder);
    return rv;
  }

  private resolve(name: string): unknown {
    if (this.variables.has(name) && this.variables.get(name) !== null && this.variables.get(name) !== undefined) return this.variables.get(name);
    const dot = name.indexOf(".");
    const root = dot >= 0 ? name.slice(0, dot) : name;
    const rest = dot >= 0 ? name.slice(dot + 1) : undefined;
    const obj = this.getObj(root);
    if (obj) return this.getVar(obj, rest);
    const v = this.variables.get(root);
    if (root && v !== null && v !== undefined) {
      if (rest !== undefined && typeof v === "object" && v && rest in (v as object)) return (v as Record<string, unknown>)[rest];
      return v;
    }
    return false; // sconosciuta: resta nel testo
  }

  replaceVars(input: string): string {
    if (!input) return input;
    const re = /(?:%\{|%%7B)([A-Za-z_][\w._]+)(?:\}|%7D)/g;
    const found = new Map<string, string>();
    for (const m of input.matchAll(re)) {
      if (found.has(m[0])) continue;
      let name = m[1];
      try {
        name = decodeURIComponent(name);
      } catch {
        /* come rawurldecode: lascia invariato */
      }
      const val = this.resolve(name);
      if (val !== false) found.set(m[0], phpString(isTemplateVariable(val) ? val.asVar(this) : val));
    }
    if (!found.size) return input;
    // str_replace con array: sostituzioni in sequenza nell'ordine di comparsa
    let out = input;
    for (const [k, v] of found) out = out.split(k).join(v);
    return out;
  }
}
