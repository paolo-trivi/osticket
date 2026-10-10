import "server-only";

import type { ConfigNamespace } from "../config/config";
import { htmlChars } from "../format/html";
import { VarBag, type TemplateVariable } from "./variables";
import { FormattedDate } from "./formatted-date";

/** Voce del thread nei template (ThreadEntry::getVar): corpo per le email, autore, date. */

export interface EntryInfo {
  id: number;
  thread_id: number;
  type: string;
  title: string | null;
  body: string;
  format: string;
  poster: string;
  staff_id: number;
  user_id: number;
  ip_address: string;
  created: string;
  updated: string;
}

/** ThreadEntryBody::display('email') */
function entryBodyForEmail(body: string, format: string): string {
  if (!body || body === "-") return "(empty)";
  if (format === "html") return body;
  return `<div style="white-space:pre-wrap">${htmlChars(body)}</div>`;
}

export function entryVar(e: EntryInfo, cfg: ConfigNamespace, dbZone: string, staff?: TemplateVariable | null): TemplateVariable {
  const body = entryBodyForEmail(e.body, e.format);
  return new VarBag(
    {
      id: e.id,
      title: e.title ?? "",
      poster: e.poster,
      body,
      message: body,
      ip_address: e.ip_address,
      create_date: new FormattedDate(e.created, cfg, dbZone),
      update_date: new FormattedDate(e.updated, cfg, dbZone),
      staff: staff ?? "",
    },
    body,
  );
}
