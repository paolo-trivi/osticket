import { NextResponse } from "next/server";

import { CHANGE_ID_RE } from "@/lib/changes";
import { installConfig } from "@/server/env";
import { conflictLabel } from "@/server/system/changes/plan";
import { lastUndoable, previewUndo, undoChange, type UndoPreview } from "@/server/system/changes/restore";
import { changesEnabled, listSummaries } from "@/server/system/changes/store";
import { internalTokenOk } from "@/server/system/internal-token";
import { canWrite } from "@/server/system/write-mode";

/**
 * Annullamento delle modifiche admin per il CLI (./tailticket undo), solo dall'interno del container
 * (sotto /api/doctor: il proxy risponde 404 da fuori) e con l'header X-Doctor-Token, come /api/doctor:
 *   GET  /api/doctor/changes            → { enabled, restoreAllowed, changes: riepiloghi con lo stato }
 *   GET  /api/doctor/changes?id=<id|last> → riepilogo, stato e righe in conflitto ("tabella id=…")
 *   POST /api/doctor/changes  {id, force} → esito dell'annullamento
 * Solo riepiloghi: mai i valori delle righe (restano nei file 0600 dell'archivio).
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const LIST_MAX = 50;
const CONFLICTS_MAX = 50;

const notFound = () => new NextResponse(null, { status: 404, headers: NO_STORE });
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

function preview(p: UndoPreview, prefix: string) {
  const s = p.summary;
  const state = s.undone ? "undone" : p.error === null ? "undoable" : p.error === "conflict" ? "conflict" : "not_undoable";
  return { ...s, state, error: p.error, conflictCount: p.conflicts.length, conflicts: p.conflicts.slice(0, CONFLICTS_MAX).map((c) => conflictLabel(c, prefix)) };
}

async function resolveId(raw: string | null): Promise<string | null> {
  if (raw === "last") return lastUndoable(await listSummaries())?.id ?? null;
  return raw && CHANGE_ID_RE.test(raw) ? raw : null;
}

export async function GET(request: Request) {
  if (!internalTokenOk(request)) return notFound();
  const prefix = installConfig().tablePrefix;
  const restoreAllowed = await canWrite("restore");
  const raw = new URL(request.url).searchParams.get("id");
  if (raw !== null) {
    const id = await resolveId(raw);
    const p = id ? await previewUndo(id) : null;
    if (!p) return json({ error: changesEnabled() ? "not_found" : "disabled", restoreAllowed }, 404);
    return json({ restoreAllowed, change: preview(p, prefix) });
  }
  const changes = [];
  for (const s of (await listSummaries()).slice(0, LIST_MAX)) {
    const p = await previewUndo(s.id).catch(() => null);
    changes.push(p ? preview(p, prefix) : { ...s, state: s.undone ? "undone" : s.undoable ? "undoable" : "not_undoable" });
  }
  return json({ enabled: changesEnabled(), restoreAllowed, changes });
}

export async function POST(request: Request) {
  if (!internalTokenOk(request)) return notFound();
  const body = (await request.json().catch(() => null)) as { id?: unknown; force?: unknown } | null;
  const id = await resolveId(typeof body?.id === "string" ? body.id : null);
  if (!id) return json({ ok: false, error: "not_found" }, 404);
  const r = await undoChange(id, { staff: null, force: body?.force === true, path: "cli" });
  const prefix = installConfig().tablePrefix;
  if (!r.ok) return json({ ...r, id, conflicts: r.conflicts?.slice(0, CONFLICTS_MAX).map((c) => conflictLabel(c, prefix)), conflictCount: r.conflicts?.length ?? 0 }, 409);
  return json({ ...r, id });
}
