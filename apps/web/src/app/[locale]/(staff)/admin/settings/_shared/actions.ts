"use server";

import type { AdminFormState } from "@/lib/admin/form-schema";
import { adminFormResult } from "@/server/actions/result";
import { parsePhpForm } from "@/server/domain/admin/form-data";
import { updateSettings, type SettingsPage } from "@/server/domain/admin/settings";
import { changeOf, withChange } from "@/server/system/changes/changeset";

import { adminWrite, requireAdminAction } from "../../_shared/server";

const PAGES: SettingsPage[] = ["system", "tickets", "tasks", "agents", "users", "pages", "kb"];

/** scp/settings.php POST: OsticketConfig::updateSettings con t = pagina. */
export async function saveSettingsAction(page: SettingsPage, _prev: AdminFormState, form: FormData): Promise<AdminFormState> {
  const { ip, locale } = await requireAdminAction();
  if (!PAGES.includes(page)) return { status: "error", errors: { err: "unknown_option" }, nonce: Date.now() };
  const vars = { ...parsePhpForm(form), t: page };
  const r = await adminWrite((tx) => updateSettings(tx, vars, { ip }));
  return adminFormResult(withChange({ ok: r.ok, errors: r.errors }, changeOf(r)), { locale });
}
