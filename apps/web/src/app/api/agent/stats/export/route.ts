import { getTranslations } from "next-intl/server";
import { NextResponse, type NextRequest } from "next/server";

import { routing, type Locale } from "@/i18n/routing";
import { currentAgent } from "@/server/auth/staff-auth";
import { statsCsv, statsCsvFilename } from "@/server/domain/stats/csv";
import { parseGroup, parsePeriod, reportRange, tabularData, TABULAR_GROUPS } from "@/server/domain/stats/report";
import { agentTimeZone } from "@/server/format/datetime";

/**
 * Export CSV della scheda attiva della dashboard (pulsante "Export" di scp/dashboard.php, che nel PHP è un POST):
 *   GET /api/agent/stats/export?group=dept|topic|staff[&start=yyyy-mm-dd][&period=…][&locale=it|en]
 * Stesso agente, stessi filtri e stessa visibilità della tabella (tabularData, che per la scheda Agente
 * applica stats.agents e i reparti gestiti). Sola lettura.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const agent = await currentAgent();
  if (!agent) return NextResponse.json({ error: "session_expired" }, { status: 403 });

  const q = request.nextUrl.searchParams;
  const rawGroup = q.get("group") ?? "";
  if (!(TABULAR_GROUPS as readonly string[]).includes(rawGroup)) return NextResponse.json({ error: "bad_group" }, { status: 400 });
  const group = parseGroup(rawGroup);
  const requested = q.get("locale") ?? request.cookies.get("NEXT_LOCALE")?.value ?? "";
  const locale: Locale = (routing.locales as readonly string[]).includes(requested) ? (requested as Locale) : routing.defaultLocale;

  const tz = await agentTimeZone(agent);
  const range = reportRange(q.get("start")?.slice(0, 32) || undefined, parsePeriod(q.get("period")), tz);
  const rows = await tabularData(group, agent, range);

  const t = await getTranslations({ locale, namespace: "dashboard" });
  const body = statsCsv(
    rows,
    {
      first: t(`groups.${group}`),
      opened: t("cols.opened"),
      assigned: t("cols.assigned"),
      overdue: t("cols.overdue"),
      closed: t("cols.closed"),
      reopened: t("cols.reopened"),
      deleted: t("cols.deleted"),
      serviceTime: t("cols.serviceTime"),
      responseTime: t("cols.responseTime"),
    },
    locale,
  );
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${statsCsvFilename(group, range.startDay, range.lastDay)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
