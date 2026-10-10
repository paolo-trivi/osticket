import type { ReactNode } from "react";

import DataTable, { PageHeader, type DataColumn } from "@/components/common/DataTable";

import AdminNotice from "./AdminNotice";
import MassBar from "./MassBar";
import NewLink from "./NewLink";

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
  notice: { ok?: string; n?: string; err?: string; cs?: string };
  extra?: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} subtitle={subtitle} actions={newHref ? <NewLink href={newHref} label={newLabel ?? ""} /> : undefined} />
      <AdminNotice ok={notice.ok} n={notice.n} err={notice.err} cs={notice.cs} />
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
