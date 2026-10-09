"use server";

import { massRedirect } from "@/server/actions/result";
import { str } from "@/server/domain/admin/php";
import { massQueues, type QueueMassAction } from "@/server/domain/adminsys/queue";

import { adminWrite, parsePhpForm, requireAdminAction, selectedIds } from "../_sys/server";

const ACTIONS: QueueMassAction[] = ["enable", "disable", "delete"];

/** scp/queues.php do=mass_process */
export async function massQueueAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as QueueMassAction;
  if (!ACTIONS.includes(a)) massRedirect("/admin/queues", locale, { ok: false, num: 0, error: "unknown_action" }, a);
  const r = await adminWrite((tx) => massQueues(tx, a, selectedIds(vars)));
  massRedirect("/admin/queues", locale, r, a);
}
