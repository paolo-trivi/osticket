import type { ThreadEntryView, ThreadEventView } from "@/server/domain/ticket/ticket";
import { formatDbDate, isoOf } from "@/server/format/datetime";
import { safeHtml, textToHtml } from "@/server/format/sanitize";
import { withBase } from "@/lib/base-path";
import { cn } from "@/utils";

import { RICH_CLASS } from "./rich";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Corpo HTML ri-sanificato; immagini inline cid:<chiave> servite dalla route del portale */
function renderBody(e: ThreadEntryView): string {
  const html = e.format === "html" ? e.body : textToHtml(e.body);
  return safeHtml(html, { decode: false }).replace(/src="cid:([A-Za-z0-9_-]+)"/g, (_, key: string) => `src="${withBase(`/api/portal/file/${key}`)}?disposition=inline"`);
}

interface Labels {
  posted: string;
  staff: string;
  edited: string;
  events: Record<string, string>;
}

/**
 * Thread visibile al cliente (include/client/templates/thread-entries.tmpl.php): messaggi e risposte
 * (mai le note interne), allegati scaricabili dalla route protetta del portale, eventi pubblici
 * (creazione, chiusura, riapertura, modifica, collaboratori, unione) in ordine cronologico.
 */
export default function PortalThread({
  entries,
  events,
  tz,
  locale,
  hideStaffName,
  labels,
}: {
  entries: ThreadEntryView[];
  events: ThreadEventView[];
  tz: string;
  locale: string;
  hideStaffName: boolean;
  labels: Labels;
}) {
  const items: ({ kind: "entry"; at: string; e: ThreadEntryView } | { kind: "event"; at: string; v: ThreadEventView })[] = [
    ...entries.map((e) => ({ kind: "entry" as const, at: e.created, e })),
    ...events.map((v) => ({ kind: "event" as const, at: v.timestamp, v })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind === "event" ? -1 : 1));

  return (
    <div className="space-y-4">
      {items.map((it) =>
        it.kind === "event" ? (
          <p key={`v${it.v.id}`} className="text-center text-theme-xs text-gray-500 dark:text-gray-400">
            {labels.events[it.v.name] ?? it.v.name} · {formatDbDate(it.v.timestamp, tz, locale, "short")}
          </p>
        ) : (
          <article
            key={`e${it.e.id}`}
            id={`entry-${it.e.id}`}
            className={cn(
              "rounded-2xl border",
              it.e.type === "R" ? "border-brand-200 bg-brand-25 dark:border-brand-800 dark:bg-brand-500/5" : "border-gray-200 bg-white dark:border-gray-800 dark:bg-white/3",
            )}
          >
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-inherit px-5 py-3">
              <p className="text-sm font-medium text-gray-800 dark:text-white/90">
                {it.e.staff_id && hideStaffName ? labels.staff : it.e.poster}{" "}
                <span className="font-normal text-gray-500 dark:text-gray-400">{labels.posted}</span>
                {it.e.title && <span className="ms-2 font-normal text-gray-400">{it.e.title}</span>}
              </p>
              <time dateTime={isoOf(it.e.created)} className="text-theme-xs text-gray-500 dark:text-gray-400">
                {formatDbDate(it.e.created, tz, locale, "full")}
                {it.e.flags & 0x0002 ? ` · ${labels.edited}` : ""}
              </time>
            </header>
            <div className={cn("px-5 py-4", RICH_CLASS)} dangerouslySetInnerHTML={{ __html: renderBody(it.e) }} />
            {it.e.attachments.some((a) => !a.inline) && (
              <footer className="flex flex-wrap gap-2 border-t border-inherit px-5 py-3">
                {it.e.attachments
                  .filter((a) => !a.inline)
                  .map((a) => (
                    <a
                      key={a.id}
                      href={withBase(`/api/portal/file/${a.key}`)}
                      className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-theme-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
                    >
                      📎 {a.name} <span className="text-gray-400">{humanSize(a.size)}</span>
                    </a>
                  ))}
              </footer>
            )}
          </article>
        ),
      )}
    </div>
  );
}
