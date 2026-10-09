"use server";

import type { AdminFormState } from "@/lib/admin/form-schema";
import { parsePhpForm, selectedIds } from "@/server/domain/admin/form-data";
import { str } from "@/server/domain/admin/php";
import { massTeams, saveTeam, type TeamMassAction } from "@/server/domain/admin/team";

import { adminWrite, formResult, massRedirect, requireAdminAction } from "../_shared/server";

/** scp/teams.php do=update / do=create */
export async function saveTeamAction(teamId: number | null, _prev: AdminFormState, form: FormData): Promise<AdminFormState> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const r = await adminWrite((tx) => saveTeam(tx, teamId, vars));
  return formResult(r, { path: "/admin/teams", locale, created: teamId ? undefined : (id) => `/admin/teams/${id}?created=1` });
}

const ACTIONS: TeamMassAction[] = ["enable", "disable", "delete"];

/** scp/teams.php do=mass_process */
export async function massTeamsAction(form: FormData): Promise<void> {
  const { locale } = await requireAdminAction();
  const vars = parsePhpForm(form);
  const a = str(vars.a) as TeamMassAction;
  if (!ACTIONS.includes(a)) massRedirect("/admin/teams", locale, { ok: false, num: 0, error: "unknown" }, a);
  const r = await adminWrite((tx) => massTeams(tx, a, selectedIds(vars)));
  massRedirect("/admin/teams", locale, r, a);
}
