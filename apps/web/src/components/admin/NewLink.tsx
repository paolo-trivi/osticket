"use client";

import { useReadOnlyHint } from "@/components/common/WriteGate";
import { Link } from "@/i18n/navigation";

const CLS = "rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-600";

/**
 * Pulsante "Nuovo …" delle liste admin. Se l'amministrazione non è scrivibile resta visibile ma
 * disattivato, con il motivo nel tooltip.
 */
export default function NewLink({ href, label }: { href: string; label: string }) {
  const readOnly = useReadOnlyHint("admin");
  if (!readOnly) {
    return (
      <Link href={href} className={CLS}>
        {label}
      </Link>
    );
  }
  return (
    <span role="link" aria-disabled="true" title={readOnly} className="cursor-not-allowed rounded-lg bg-brand-300 px-4 py-2.5 text-sm font-medium text-white">
      {label}
    </span>
  );
}
