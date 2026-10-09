import { Link } from "@/i18n/navigation";

export default function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="text-sm font-medium text-brand-500 hover:text-brand-600">
      <span className="inline-block rtl:rotate-180">←</span> {label}
    </Link>
  );
}

export function NewButton({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-600">
      {label}
    </Link>
  );
}
