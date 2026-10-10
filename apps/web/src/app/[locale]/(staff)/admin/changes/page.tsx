import { DateTime } from "luxon";
import { getTranslations, setRequestLocale } from "next-intl/server";

import AdminNotice from "@/components/admin/AdminNotice";
import UndoChange from "@/components/admin/UndoChange";
import Callout from "@/components/common/Callout";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import LinkPager from "@/components/common/LinkPager";
import Badge from "@/components/ui/badge/Badge";
import { MAX_CHANGE_ROWS } from "@/lib/changes";
import { installConfig } from "@/server/env";
import { agentTimeZone } from "@/server/format/datetime";
import { changeRef } from "@/server/system/changes/changeset";
import { previewUndo } from "@/server/system/changes/restore";
import { changesEnabled, listSummaries } from "@/server/system/changes/store";
import type { ChangeSummary } from "@/server/system/changes/types";
import { canWrite } from "@/server/system/write-mode";

import { requireAdmin } from "../guard";
import { adminMetadata } from "../metadata";

export const generateMetadata = adminMetadata("changes");

const PER_PAGE = 25;

type State = "undoable" | "undone" | "notUndoable" | "conflict";
const COLOR: Record<State, "success" | "light" | "warning" | "error"> = { undoable: "success", undone: "light", notUndoable: "warning", conflict: "error" };

/**
 * Modifiche recenti dell'area admin (changeset registrati da adminWrite e dal tema): quando, chi,
 * pagina, tabelle e righe, stato (annullabile / annullata / non annullabile / in conflitto) e
 * "Annulla". Solo il riepilogo: i valori delle righe restano nei file dell'archivio, mai in pagina.
 * Pulsanti attivi solo se l'annullamento è consentito (modalità configurata full, schema verificato).
 */
export default async function ChangesPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAdmin(locale);
  const t = await getTranslations("admChanges");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const enabled = changesEnabled();
  const [canRestore, canAdmin] = await Promise.all([canWrite("restore"), canWrite("admin")]);
  const all = enabled ? await listSummaries() : [];
  const page = Math.max(1, Number(sp.p) || 1);
  const rows = all.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const tz = await agentTimeZone(agent);
  const prefix = installConfig().tablePrefix;
  const plain = (table: string) => (prefix && table.startsWith(prefix) ? table.slice(prefix.length) : table);

  const stateOf = async (s: ChangeSummary): Promise<{ state: State; note?: string }> => {
    if (s.undone) return { state: "undone" };
    if (!s.undoable) return { state: "notUndoable", note: t(`reasons.${s.reason ?? "capture_failed"}`, { max: MAX_CHANGE_ROWS }) };
    const p = await previewUndo(s.id).catch(() => null);
    if (!p || p.error === null) return { state: "undoable" };
    if (p.error === "conflict") return { state: "conflict", note: t("conflictHint", { n: p.conflicts.length }) };
    return { state: "notUndoable", note: t(`errors.${p.error}`) };
  };
  const states = await Promise.all(rows.map(stateOf));

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <AdminNotice ok={sp.ok} />
      {!enabled && <Callout tone="info">{t("disabledNotice")}</Callout>}
      {enabled && !canRestore && <Callout tone="info">{t("restoreOff")}</Callout>}
      {enabled && canRestore && !canAdmin && <Callout tone="warning">{t("restoreOnly")}</Callout>}
      <p className="text-sm text-gray-600 dark:text-gray-400">{t("hint", { max: MAX_CHANGE_ROWS })}</p>
      <DataTable
        empty={t("empty")}
        columns={[
          { key: "when", label: t("when"), className: "whitespace-nowrap" },
          { key: "who", label: t("who") },
          { key: "op", label: t("op") },
          { key: "tables", label: t("tables") },
          { key: "state", label: t("state") },
          { key: "actions", label: "", className: "w-44" },
        ]}
        rows={rows.map((s, i) => {
          const { state, note } = states[i];
          const tables = Object.keys(s.touched).length ? Object.keys(s.touched) : Object.keys(s.tables);
          return {
            key: s.id,
            cells: {
              when: <span title={s.id}>{DateTime.fromISO(s.ts).setZone(tz).setLocale(locale).toLocaleString(DateTime.DATETIME_MED)}</span>,
              who: s.staff?.username ?? t("cli"),
              op: <span className="break-all">{s.undoes ? t("undoOf", { id: s.undoes }) : (s.path ?? s.op ?? "—")}</span>,
              tables: (
                <div className="space-y-0.5 text-theme-xs">
                  <p>{t("rows", { n: s.rows })}</p>
                  {tables.map((tb) => {
                    const n = s.tables[tb];
                    return <p key={tb}>{n ? t("tableCounts", { table: plain(tb), insert: n.insert, update: n.update, delete: n.delete }) : `${plain(tb)}: ${s.touched[tb]?.join(", ")}`}</p>;
                  })}
                </div>
              ),
              state: (
                <div className="space-y-1">
                  <Badge size="sm" color={COLOR[state]}>
                    {t(`states.${state}`)}
                  </Badge>
                  {note && <p className="text-theme-xs text-gray-500 dark:text-gray-400">{note}</p>}
                </div>
              ),
              actions:
                state === "undoable" || state === "conflict" ? (
                  <UndoChange change={changeRef(s)} disabled={!canRestore ? t("restoreOff") : state === "conflict" ? t("errors.conflict") : undefined} />
                ) : null,
            },
          };
        })}
      />
      <LinkPager page={page} totalPages={Math.max(1, Math.ceil(all.length / PER_PAGE))} href={(p: number) => `/admin/changes?p=${p}`} labels={{ prev: c("prev"), next: c("next") }} />
    </div>
  );
}
