import type { ReactNode } from "react";

/** Riga etichetta/valore delle schede laterali della vista ticket ("—" se il valore è vuoto). */
export default function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-end text-gray-800 dark:text-white/90">{children || "—"}</dd>
    </div>
  );
}
