"use server";

import { revalidatePath } from "next/cache";

import { CHANGE_ID_RE, type UndoState } from "@/lib/changes";
import { requestPathForChanges } from "@/server/system/changes/changeset";
import { conflictLabel } from "@/server/system/changes/plan";
import { undoChange } from "@/server/system/changes/restore";
import { installConfig } from "@/server/env";

import { requireAdminAction } from "../_shared/server";

/** Righe in conflitto mostrate al più nell'esito (le altre sono nel CLI: ./tailticket undo <id>). */
const MAX_CONFLICTS = 20;

/** "Annulla modifica" (banner dei salvataggi admin e Modifiche recenti): solo amministratori, mai con force. */
export async function undoChangeAction(id: string): Promise<UndoState> {
  const { agent } = await requireAdminAction();
  if (!CHANGE_ID_RE.test(id)) return { status: "error", error: "not_found" };
  const r = await undoChange(id, { staff: { id: agent.id, username: agent.username }, path: await requestPathForChanges() });
  if (!r.ok) {
    const prefix = installConfig().tablePrefix;
    return { status: "error", error: r.error, conflicts: r.conflicts?.slice(0, MAX_CONFLICTS).map((c) => conflictLabel(c, prefix)) };
  }
  // il tema è letto dal layout radice: si invalida tutto
  revalidatePath("/", "layout");
  return { status: "done", change: r.change };
}
