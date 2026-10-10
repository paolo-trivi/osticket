"use server";

import type { SysFormState } from "@/components/adminsys/SysForm";
import { massRedirect, sysFormResult } from "@/server/actions/result";
import { str } from "@/server/php/values";
import { addTemplateGroup, implementTemplate, massTemplateGroups, updateTemplate, updateTemplateGroup, type TemplateMassAction } from "@/server/domain/adminsys/template";

import { adminWrite, parsePhpForm, requireAdminAction, selectedIds } from "../_sys/server";

/** scp/templates.php do=add (nuovo set, eventualmente clonato) */
export async function addTemplateGroupAction(_prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale } = await requireAdminAction();
  const r = await adminWrite((tx) => addTemplateGroup(tx, parsePhpForm(form)));
  return sysFormResult(r, { locale, created: (id) => `/admin/templates/${id}?ok=created` });
}

/** scp/templates.php do=update */
export async function updateTemplateGroupAction(tplId: number, _prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale } = await requireAdminAction();
  const vars = { ...parsePhpForm(form), tpl_id: String(tplId) };
  const r = await adminWrite((tx) => updateTemplateGroup(tx, tplId, vars));
  return sysFormResult(r, { locale });
}

/** scp/templates.php do=updatetpl (messaggio esistente) o do=implement (messaggio mancante nel set) */
export async function saveTemplateAction(tplId: number, code: string, templateId: number | null, _prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale, agent } = await requireAdminAction();
  const vars = parsePhpForm(form);
  if (templateId) {
    const r = await adminWrite((tx) => updateTemplate(tx, templateId, vars));
    return sysFormResult(r, { locale });
  }
  const r = await adminWrite((tx) => implementTemplate(tx, tplId, { ...vars, tpl_id: String(tplId), code_name: code }, agent.id));
  return sysFormResult(r, { locale, created: () => `/admin/templates/${tplId}/${code.replace(/\./g, "-")}?ok=created` });
}

const ACTIONS: TemplateMassAction[] = ["enable", "disable", "delete"];

/** scp/templates.php do=mass_process */
export async function massTemplateAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as TemplateMassAction;
  if (!ACTIONS.includes(a)) massRedirect("/admin/templates", locale, { ok: false, num: 0, error: "unknown_action" }, a);
  const r = await adminWrite((tx) => massTemplateGroups(tx, a, selectedIds(vars)));
  massRedirect("/admin/templates", locale, r, a);
}
