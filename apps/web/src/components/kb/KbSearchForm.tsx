import { Link } from "@/i18n/navigation";
import { withBase } from "@/lib/base-path";

export interface KbSearchOption {
  id: number;
  label: string;
}

export interface KbSearchLabels {
  search: string;
  searchButton: string;
  reset: string;
  category: string;
  topic: string;
  allCategories: string;
  allTopics: string;
}

const control =
  "h-10 w-full rounded-lg border border-gray-200 bg-transparent px-3 text-sm text-gray-800 focus:border-brand-300 focus:outline-hidden dark:border-gray-800 dark:bg-gray-900 dark:text-white/90";

/**
 * Ricerca FAQ con filtri per categoria e help topic (form #kbSearch di faq-categories.inc.php).
 * Form GET senza JavaScript: i filtri sono parametri dell'URL (q, cid, topicId).
 */
export default function KbSearchForm({
  q,
  categoryId,
  topicId,
  categories,
  topics,
  labels,
  active,
}: {
  q: string;
  categoryId: number;
  topicId: number;
  categories: readonly KbSearchOption[];
  topics: readonly KbSearchOption[];
  labels: KbSearchLabels;
  active: boolean;
}) {
  return (
    <form action={withBase("/agent/kb")} method="get" role="search" className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
      <input
        type="search"
        name="q"
        defaultValue={q}
        placeholder={labels.search}
        aria-label={labels.search}
        className={`${control} placeholder:text-gray-400`}
      />
      <select name="cid" defaultValue={String(categoryId)} aria-label={labels.category} className={control}>
        <option value="0">{labels.allCategories}</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <select name="topicId" defaultValue={String(topicId)} aria-label={labels.topic} className={control}>
        <option value="0">{labels.allTopics}</option>
        {topics.map((tp) => (
          <option key={tp.id} value={tp.id}>
            {tp.label}
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        <button type="submit" name="a" value="search" className="h-10 flex-1 rounded-lg bg-brand-500 px-4 text-sm font-medium text-white hover:bg-brand-600 md:flex-none">
          {labels.searchButton}
        </button>
        {active && (
          <Link
            href="/agent/kb"
            className="inline-flex h-10 flex-1 items-center justify-center rounded-lg border border-gray-200 px-4 text-sm text-gray-700 hover:bg-gray-50 md:flex-none dark:border-gray-800 dark:text-gray-300 dark:hover:bg-white/3"
          >
            {labels.reset}
          </Link>
        )}
      </div>
    </form>
  );
}
