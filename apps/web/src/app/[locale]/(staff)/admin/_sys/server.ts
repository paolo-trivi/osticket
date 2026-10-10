import "server-only";

import { parsePhpForm, selectedIds } from "@/server/domain/admin/form-data";
import type { DbDateTime } from "@/server/db/schema.gen";
import type { Agent } from "@/server/domain/staff/staff";
import { agentTimeZone, formatDbDate, type DateStyle } from "@/server/format/datetime";

import { adminWrite, requireAdminAction } from "../_shared/server";

/**
 * Supporto alle server action dell'area admin di sistema (email, filtri, form, liste, pagine,
 * code, API key, log, plugin): sessione e isadmin ricontrollati a ogni chiamata
 * (requireAdminAction), scrittura in transazione. Gli esiti (sysFormResult, massRedirect) sono in
 * server/actions/result.
 */
export { adminWrite, parsePhpForm, requireAdminAction, selectedIds };

/** Formattatore delle date del DB nel fuso dell'agente (Format::datetime). */
export async function dateFormatter(agent: Agent, locale: string): Promise<(v: unknown, style?: DateStyle) => string> {
  const tz = await agentTimeZone(agent);
  return (v, style = "short") => (v ? formatDbDate(String(v) as DbDateTime, tz, locale, style) : "—");
}
