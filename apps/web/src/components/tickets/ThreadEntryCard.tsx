import { renderThreadBody } from "@/components/common/thread-body";
import { ThreadEntryType } from "@/lib/osticket/object-types";
import type { ThreadEntryView } from "@/server/domain/ticket/ticket";
import { formatDbDate, isoOf } from "@/server/format/datetime";
import { cn } from "@/utils";
import { withBase } from "@/lib/base-path";
import { humanSize } from "@/lib/format/size";

const KIND_STYLE: Record<ThreadEntryView["type"], string> = {
  M: "border-gray-200 bg-white dark:border-gray-800 dark:bg-white/3",
  R: "border-brand-200 bg-brand-25 dark:border-brand-800 dark:bg-brand-500/5",
  N: "border-warning-200 bg-warning-25 dark:border-warning-800 dark:bg-warning-500/5",
};

export default function ThreadEntryCard({
  entry,
  tz,
  locale,
  labels,
  iframeWhitelist,
}: {
  entry: ThreadEntryView;
  tz: string;
  locale: string;
  labels: { note: string; reply: string; message: string; edited: string; via: string };
  iframeWhitelist: string[];
}) {
  const kindLabel = entry.type === ThreadEntryType.NOTE ? labels.note : entry.type === ThreadEntryType.RESPONSE ? labels.reply : labels.message;
  const files = entry.attachments.filter((a) => !a.inline);
  return (
    <article id={`entry-${entry.id}`} className={cn("rounded-2xl border", KIND_STYLE[entry.type])}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-inherit px-5 py-3">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex size-9 items-center justify-center rounded-full text-sm font-semibold",
              entry.type === ThreadEntryType.MESSAGE ? "bg-gray-100 text-gray-600 dark:bg-white/5 dark:text-gray-300" : "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300",
            )}
          >
            {entry.poster.slice(0, 2).toUpperCase()}
          </span>
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-white/90">{entry.poster}</p>
            <p className="text-theme-xs text-gray-500 dark:text-gray-400">
              {kindLabel}
              {entry.source ? ` · ${labels.via} ${entry.source}` : ""}
            </p>
          </div>
        </div>
        <time dateTime={isoOf(entry.created)} className="text-theme-xs text-gray-500 dark:text-gray-400">
          {formatDbDate(entry.created, tz, locale, "full")}
          {entry.editor_name ? ` · ${labels.edited} ${entry.editor_name}` : ""}
        </time>
      </header>
      {entry.title && entry.type === ThreadEntryType.NOTE && (
        <p className="px-5 pt-3 text-sm font-semibold text-gray-700 dark:text-gray-300">{entry.title}</p>
      )}
      <div
        className="thread-body prose prose-sm max-w-none px-5 py-4 text-gray-700 dark:prose-invert dark:text-gray-300"
        dangerouslySetInnerHTML={{ __html: renderThreadBody(entry, { area: "agent", iframeWhitelist }) }}
      />
      {files.length > 0 && (
        <footer className="flex flex-wrap gap-2 border-t border-inherit px-5 py-3">
          {files.map((a) => (
            <a
              key={a.id}
              href={withBase(`/api/agent/file/${a.key}`)}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-theme-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
            >
              📎 {a.name} <span className="text-gray-400">{humanSize(a.size)}</span>
            </a>
          ))}
        </footer>
      )}
    </article>
  );
}
