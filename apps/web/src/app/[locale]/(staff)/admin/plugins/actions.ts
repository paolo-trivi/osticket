"use server";

import { massRedirect } from "@/server/actions/result";
import { str } from "@/server/php/values";
import { massPluginInstances, massPlugins, type InstanceMassAction, type PluginMassAction } from "@/server/domain/adminsys/plugin";

import { adminWrite, parsePhpForm, requireAdminAction, selectedIds } from "../_sys/server";

/** scp/plugins.php do=mass_process (abilita/disabilita) */
export async function massPluginAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as PluginMassAction;
  if (a !== "enable" && a !== "disable") massRedirect("/admin/plugins", locale, { ok: false, num: 0, error: "unknown_action" }, a);
  const r = await adminWrite((tx) => massPlugins(tx, a, selectedIds(vars)));
  massRedirect("/admin/plugins", locale, r, a);
}

/** scp/plugins.php do=instances-actions (abilita/disabilita) */
export async function massInstanceAction(pluginId: number, form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as InstanceMassAction;
  if (a !== "enable" && a !== "disable") massRedirect("/admin/plugins", locale, { ok: false, num: 0, error: "unknown_action" }, a);
  const r = await adminWrite((tx) => massPluginInstances(tx, pluginId, a, selectedIds(vars)));
  massRedirect("/admin/plugins", locale, r, a);
}
