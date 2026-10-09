import { Link } from "@/i18n/navigation";
import { cn } from "@/utils";

interface FormatOption {
  key: string;
  label: string;
  href: string;
  active: boolean;
}

/** Selettore HTML / testo semplice del testo della risposta (Canned::getHtml / getPlainText). */
export default function CannedFormatSwitch({ options, label }: { options: readonly FormatOption[]; label: string }) {
  return (
    <nav aria-label={label} className="inline-flex rounded-lg border border-gray-200 p-0.5 dark:border-gray-800">
      {options.map((o) => (
        <Link
          key={o.key}
          href={o.href}
          aria-current={o.active ? "page" : undefined}
          replace
          scroll={false}
          className={cn(
            "rounded-md px-3 py-1 text-theme-xs font-medium",
            o.active ? "bg-brand-500 text-white" : "text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-white/5",
          )}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  );
}
