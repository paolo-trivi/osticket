import { Link } from "@/i18n/navigation";
import { FolderIcon } from "@/icons";

import VisibilityBadge, { type VisibilityLabels } from "./VisibilityBadge";

export interface SubcategoryEntry {
  id: number;
  name: string;
  visibility: 0 | 1 | 2;
  faqCount: number;
}

/** Sottocategorie con numero di FAQ e visibilità (Category::children). */
export default function SubcategoryList({
  items,
  labels,
  countLabel,
}: {
  items: readonly SubcategoryEntry[];
  labels: VisibilityLabels;
  countLabel: (n: number) => string;
}) {
  return (
    <ul className="space-y-2">
      {items.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-2">
          <FolderIcon className="size-4 shrink-0 text-gray-400 dark:text-gray-500" aria-hidden />
          <Link href={`/agent/kb/category/${c.id}`} className="min-w-0 text-sm font-medium break-words text-brand-600 hover:underline dark:text-brand-400">
            {c.name}
          </Link>
          <span className="text-theme-xs text-gray-500 dark:text-gray-400">{countLabel(c.faqCount)}</span>
          <VisibilityBadge visibility={c.visibility} labels={labels} />
        </li>
      ))}
    </ul>
  );
}
