import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import { cn } from "@/utils";

/** Paginazione con link (server component): conserva gli altri parametri della query. */
export default function LinkPager({
  page,
  totalPages,
  href,
  labels,
}: {
  page: number;
  totalPages: number | null;
  /** costruisce l'URL di una pagina */
  href: (p: number) => string;
  labels: { prev: string; next: string };
}) {
  const t = useTranslations("common");
  const last = totalPages ?? page + 1;
  const pages: number[] = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(last, page + 2); p++) pages.push(p);
  const btn =
    "flex h-9 min-w-9 items-center justify-center rounded-lg px-3 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5";
  return (
    <nav className="flex items-center gap-1" aria-label={t("pagination")}>
      {page > 1 ? (
        <Link href={href(page - 1)} className={cn(btn, "border border-gray-200 dark:border-gray-800")}>
          {labels.prev}
        </Link>
      ) : null}
      {pages.map((p) => (
        <Link
          key={p}
          href={href(p)}
          aria-current={p === page ? "page" : undefined}
          className={cn(btn, p === page && "bg-brand-500 text-white hover:bg-brand-600 dark:text-white")}
        >
          {p}
        </Link>
      ))}
      {totalPages === null || page < totalPages ? (
        <Link href={href(page + 1)} className={cn(btn, "border border-gray-200 dark:border-gray-800")}>
          {labels.next}
        </Link>
      ) : null}
    </nav>
  );
}
