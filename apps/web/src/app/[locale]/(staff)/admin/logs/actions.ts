"use server";

import { massRedirect } from "@/server/actions/result";
import { deleteLogs } from "@/server/domain/adminsys/logs";

import { adminWrite, parsePhpForm, requireAdminAction, selectedIds } from "../_sys/server";

/** scp/logs.php do=mass_process a=delete */
export async function deleteLogsAction(query: string, form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const r = await adminWrite((tx) => deleteLogs(tx, selectedIds(parsePhpForm(form))));
  massRedirect(`/admin/logs${query}`, locale, r, "delete");
}
