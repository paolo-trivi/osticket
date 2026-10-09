"use server";

import type { AdminFormState } from "@/lib/admin/form-schema";
import { adminFormResult, massRedirect } from "@/server/actions/result";
import { parsePhpForm, selectedIds } from "@/server/domain/admin/form-data";
import { str } from "@/server/domain/admin/php";
import { massTopics, saveTopic, type TopicMassAction } from "@/server/domain/admin/topic";

import { adminWrite, requireAdminAction } from "../_shared/server";

/** scp/helptopics.php do=update / do=create */
export async function saveTopicAction(topicId: number | null, _prev: AdminFormState, form: FormData): Promise<AdminFormState> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const r = await adminWrite((tx) => saveTopic(tx, topicId, vars));
  return adminFormResult(r, { locale, created: topicId ? undefined : (id) => `/admin/topics/${id}?created=1` });
}

const ACTIONS: TopicMassAction[] = ["enable", "disable", "archive", "delete", "sort"];

/** scp/helptopics.php do=mass_process (anche a=sort con help_topic_sort_mode e sort-<id>) */
export async function massTopicsAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as TopicMassAction;
  if (!ACTIONS.includes(a)) massRedirect("/admin/topics", locale, { ok: false, num: 0, error: "unknown" }, a);
  const r = await adminWrite((tx) => massTopics(tx, a, selectedIds(vars), vars));
  massRedirect("/admin/topics", locale, r, a);
}
