import { ArrowLeft } from "lucide-react";

import NewLink from "@/components/admin/NewLink";
import { Link } from "@/i18n/navigation";

export default function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-500 hover:text-brand-600">
      <ArrowLeft className="size-4 rtl:rotate-180" /> {label}
    </Link>
  );
}

/** "Nuovo …" delle liste admin (disattivato se l'amministrazione non è scrivibile). */
export function NewButton({ href, label }: { href: string; label: string }) {
  return <NewLink href={href} label={label} />;
}
