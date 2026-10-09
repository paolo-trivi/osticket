import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";

import VisibilityBadge, { type VisibilityLabels } from "./VisibilityBadge";

/** Categoria di primo livello nella pagina principale della KB (#kb di faq-categories.inc.php). */
export default function CategoryCard({
  id,
  name,
  visibility,
  countLabel,
  descriptionHtml,
  labels,
  children,
}: {
  id: number;
  name: string;
  visibility: 0 | 1 | 2;
  countLabel: string;
  descriptionHtml: string;
  labels: VisibilityLabels;
  /** sottocategorie */
  children?: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-white/3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 font-medium break-words text-gray-800 dark:text-white/90">
          <Link href={`/agent/kb/category/${id}`} className="hover:text-brand-500 dark:hover:text-brand-400">
            {name}
          </Link>
        </h3>
        <VisibilityBadge visibility={visibility} labels={labels} />
      </div>
      {descriptionHtml && (
        <div className="thread-body line-clamp-3 text-sm break-words text-gray-500 dark:text-gray-400" dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
      )}
      {children}
      <p className="mt-auto text-theme-xs text-gray-400 dark:text-gray-500">{countLabel}</p>
    </section>
  );
}
