import { Fragment } from "react";

import { Link } from "@/i18n/navigation";
import { ChevronLeft } from "lucide-react";

interface BreadcrumbItem {
  label: string;
  /** assente per la voce corrente */
  href?: string;
}

/** Percorso "Tutte le categorie › Padre › Figlio" della knowledge base (faq-view.inc.php #breadcrumbs). */
export default function KbBreadcrumb({ items, label }: { items: readonly BreadcrumbItem[]; label: string }) {
  return (
    <nav aria-label={label}>
      <ol className="flex flex-wrap items-center gap-1.5 text-sm">
        {items.map((item, i) => (
          <Fragment key={`${i}-${item.label}`}>
            {i > 0 && (
              <li aria-hidden className="text-gray-400 dark:text-gray-500">
                <ChevronLeft className="size-4 rotate-180 rtl:rotate-0" />
              </li>
            )}
            <li className="min-w-0 break-words">
              {item.href ? (
                <Link href={item.href} className="text-gray-500 hover:text-brand-500 dark:text-gray-400 dark:hover:text-brand-400">
                  {item.label}
                </Link>
              ) : (
                <span aria-current="page" className="text-gray-800 dark:text-white/90">
                  {item.label}
                </span>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
