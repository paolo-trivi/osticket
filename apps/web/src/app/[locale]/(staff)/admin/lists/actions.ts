"use server";

import type { SysFormState } from "@/components/adminsys/SysForm";
import { massRedirect, sysFormResult } from "@/server/actions/result";
import { str } from "@/server/domain/admin/php";
import { addList, addListItem, deleteLists, massListItems, updateList, updateListItem, type ItemMassAction } from "@/server/domain/adminsys/list";

import { adminWrite, parsePhpForm, requireAdminAction, selectedIds } from "../_sys/server";

/** scp/lists.php do=add / do=update */
export async function saveListAction(listId: number | null, _prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const r = await adminWrite((tx) => (listId ? updateList(tx, listId, vars) : addList(tx, vars)));
  return sysFormResult(r, { locale, created: listId ? undefined : (id) => `/admin/lists/${id}?ok=created` });
}

/** scp/lists.php do=mass_process a=delete */
export async function massListAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const r = await adminWrite((tx) => deleteLists(tx, selectedIds(parsePhpForm(form))));
  massRedirect("/admin/lists", locale, r, "delete");
}

/** ajax.forms.php addListItem / saveListItem */
export async function saveListItemAction(listId: number, itemId: number | null, _prev: SysFormState, form: FormData): Promise<SysFormState> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const r = await adminWrite((tx) => (itemId ? updateListItem(tx, listId, itemId, vars) : addListItem(tx, listId, vars)));
  return sysFormResult(r, { locale });
}

const ITEM_ACTIONS: ItemMassAction[] = ["enable", "disable", "delete"];

/** ajax.forms.php disableItems / undisableItems / deleteItems */
export async function massListItemAction(listId: number, form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as ItemMassAction;
  const path = `/admin/lists/${listId}`;
  if (!ITEM_ACTIONS.includes(a)) massRedirect(path, locale, { ok: false, num: 0, error: "unknown_action" }, a);
  const r = await adminWrite((tx) => massListItems(tx, listId, a, selectedIds(vars)));
  massRedirect(path, locale, r, a);
}
