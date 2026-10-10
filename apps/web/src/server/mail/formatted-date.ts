import "server-only";

import { DateTime } from "luxon";

import type { ConfigNamespace } from "../config/config";
import { phpFormatDate } from "../format/datetime";
import type { TemplateVariable } from "./variables";

/**
 * FormattedDate (include/class.format.php): Format::date/datetime/time/daydatetime nel fuso di sistema.
 * Con `date_formats = custom` si usano i pattern della configurazione; altrimenti i formati ICU della
 * lingua di sistema (date SHORT, ora SHORT, "long" = pattern data + " " + pattern ora, "full" = FULL + SHORT).
 */
export class FormattedDate implements TemplateVariable {
  constructor(
    private readonly value: string,
    private readonly cfg: ConfigNamespace,
    private readonly dbZone: string,
  ) {}
  private fmt(kind: "short" | "long" | "time" | "full"): string {
    const dt = DateTime.fromSQL(this.value, { zone: this.dbZone });
    if (!dt.isValid) return "";
    const php = ({ short: "date", long: "datetime", time: "time", full: "daydatetime" } as const)[kind];
    return phpFormatDate(dt, this.cfg, this.cfg.str("default_timezone") || this.dbZone, php);
  }
  getVar(tag: string): unknown {
    switch (tag) {
      case "short":
      case "long":
      case "time":
      case "full": return this.fmt(tag);
      case "system":
      case "user": return this.fmt("long");
    }
    return undefined;
  }
  asVar(): string {
    return this.fmt("long");
  }
}
