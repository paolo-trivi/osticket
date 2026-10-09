import type { ReactNode } from "react";

import DataTable, { PageHeader, type DataColumn } from "@/components/common/DataTable";
import { Link } from "@/i18n/navigation";

import AdminNotice from "./AdminNotice";
import MassBar from "./MassBar";

/**
 * Lista dell'area admin: intestazione con "Nuovo", esito delle azioni di massa, tabella con le
 * caselle ids[] dentro un form inviato alla server action mass_process.
 */
export default function AdminList({
  title,
  subtitle,
  newHref,
  newLabel,
  action,
  actions,
  columns,
  rows,
  empty,
  notice,
  extra,
}: {
  title: string;
  subtitle?: string;
  newHref?: string;
  newLabel?: string;
  action: (form: FormData) => Promise<void>;
  actions: { value: string; label: string; danger?: boolean }[];
  columns: DataColumn[];
  rows: { id: number; label: string; cells: Record<string, ReactNode> }[];
  empty: string;
  notice: { ok?: string; n?: string; err?: string };
  extra?: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          newHref ? (
            <Link href={newHref} className="rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-600">
              {newLabel}
            </Link>
          ) : undefined
        }
      />
      <AdminNotice ok={notice.ok} n={notice.n} err={notice.err} />
      <form action={action} className="space-y-4">
        <MassBar actions={actions} />
        <DataTable
          empty={empty}
          columns={[{ key: "sel", label: "", className: "w-10" }, ...columns]}
          rows={rows.map((r) => ({
            key: r.id,
            cells: { sel: <input type="checkbox" name="ids[]" value={r.id} className="h-4 w-4 accent-brand-500" aria-label={r.label} />, ...r.cells },
          }))}
        />
        {extra}
      </form>
    </div>
  );
}
