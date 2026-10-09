import { Link } from "@/i18n/navigation";
import { PaperclipIcon } from "@/icons";

import VisibilityBadge, { type VisibilityLabels } from "./VisibilityBadge";

interface FaqListEntry {
  id: number;
  question: string;
  visibility: 0 | 1 | 2;
  attachmentCount: number;
  /** categoria mostrata sotto la domanda (risultati di ricerca) */
  category?: string;
}

/** Elenco di FAQ con visibilità e graffetta se ci sono allegati (faq-category.inc.php #faq). */
export default function FaqList({
  faqs,
  empty,
  labels,
  attachmentsLabel,
}: {
  faqs: readonly FaqListEntry[];
  empty: string;
  labels: VisibilityLabels;
  attachmentsLabel: (n: number) => string;
}) {
  if (!faqs.length) return <p className="text-sm text-gray-500 dark:text-gray-400">{empty}</p>;
  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
      {faqs.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <Link href={`/agent/kb/faq/${f.id}`} className="text-sm font-medium break-words text-brand-600 hover:underline dark:text-brand-400">
              {f.question}
            </Link>
            {f.category && <p className="mt-0.5 text-theme-xs text-gray-500 dark:text-gray-400">{f.category}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {f.attachmentCount > 0 && (
              <span className="inline-flex items-center gap-1 text-theme-xs text-gray-500 dark:text-gray-400" title={attachmentsLabel(f.attachmentCount)}>
                <PaperclipIcon className="size-4" aria-hidden />
                <span className="sr-only">{attachmentsLabel(f.attachmentCount)}</span>
                <span aria-hidden>{f.attachmentCount}</span>
              </span>
            )}
            <VisibilityBadge visibility={f.visibility} labels={labels} />
          </div>
        </li>
      ))}
    </ul>
  );
}
