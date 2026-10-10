import "server-only";

import { CHANGE_ID_RE } from "@/lib/changes";
import { changeRef } from "@/server/system/changes/changeset";
import { loadSummary } from "@/server/system/changes/store";

import UndoChange from "./UndoChange";

/**
 * "Annulla modifica" nei banner d'esito passati in query string (?cs=<id> dopo un'azione di massa o una
 * creazione): stato letto dal riepilogo della modifica (mai i valori). Con `leave` (elemento appena
 * creato) dopo l'annullamento si torna alla pagina superiore.
 */
export default async function NoticeUndo({ cs, leave = false }: { cs?: string; leave?: boolean }) {
  if (!cs || !CHANGE_ID_RE.test(cs)) return null;
  const summary = await loadSummary(cs).catch(() => null);
  if (!summary || summary.undone) return null;
  return <UndoChange change={changeRef(summary)} leave={leave} />;
}
