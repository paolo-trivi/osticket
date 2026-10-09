"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { z } from "zod";

import { clientIp } from "@/server/auth/session";
import { currentAgent } from "@/server/auth/staff-auth";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { loadBoardCell } from "@/server/domain/board/board";
import { parseBoardParams } from "@/server/domain/board/params";
import { ticketPreview, type BoardPreview } from "@/server/domain/board/preview";
import type { BoardCard, MoveErrorCode } from "@/server/domain/board/types";
import { changeTicketStatus, closeBlocker } from "@/server/domain/ticket/ticket-state";
import { runWrite } from "@/server/domain/write";

export type MoveResult = { ok: true; ticketId: number; statusId: number } | { ok: false; error: MoveErrorCode };

const MoveInput = z.object({
  ticketId: z.number().int().positive(),
  statusId: z.number().int().positive(),
});

/** Codice d'errore della board (testi tradotti in board.errors) per un errore di changeTicketStatus. */
async function moveError(error: string, ticketId: number): Promise<MoveErrorCode> {
  switch (error) {
    case "denied":
      return "forbidden";
    case "already_status":
      return "same_status";
    case "not_found":
      return "not_found";
    case "invalid_status":
    case "not_supported":
      return "invalid_status";
    case "not_closeable": {
      // Motivo dalla stessa verifica del modale di chiusura (Ticket::isCloseable), mai il testo inglese
      const blocker = await closeBlocker(db(), await coreConfig(), ticketId).catch(() => null);
      if (blocker?.reason === "tasks") return "open_tasks";
      if (blocker?.reason === "fields") return "missing_fields";
      if (blocker?.reason === "topic") return "topic_required";
      return "not_closeable";
    }
    default:
      return "internal";
  }
}

/**
 * Cambio stato dal drag & drop o dal menu "Sposta in…" della card: solo tramite changeTicketStatus
 * (ajax.tickets.php:setTicketStatus), senza commento né figli; lo stato "deleted" non è mai proposto.
 */
export async function moveTicketAction(input: { ticketId: number; statusId: number }): Promise<MoveResult> {
  const agent = await currentAgent();
  if (!agent) return { ok: false, error: "session" };
  const parsed = MoveInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { ticketId, statusId } = parsed.data;
  let result: Awaited<ReturnType<typeof changeTicketStatus>>;
  try {
    result = await runWrite({ agent, ip: await clientIp() }, (ctx) => changeTicketStatus(ctx, { ticketId, statusId }));
  } catch (err) {
    console.error("[board] cambio stato fallito", err);
    return { ok: false, error: "internal" };
  }
  if ("error" in result) return { ok: false, error: await moveError(result.error, ticketId) };
  // Board, lista, vista del ticket e contatori delle code: invalidazione di tutte le pagine (sono dinamiche)
  revalidatePath("/", "layout");
  return { ok: true, ticketId, statusId };
}

const MoreInput = z.object({
  /** search params della board (stessa vista) */
  query: z.string().max(2000),
  lane: z.string().min(1).max(40),
  col: z.string().min(1).max(40),
  offset: z.number().int().min(0).max(100000),
});

export type LoadMoreResult = { ok: true; cards: BoardCard[]; total: number } | { ok: false; error: "session" | "invalid" | "load" };

/** "Carica altri" di una cella della board. */
export async function loadMoreCardsAction(input: { query: string; lane: string; col: string; offset: number }): Promise<LoadMoreResult> {
  const agent = await currentAgent();
  if (!agent) return { ok: false, error: "session" };
  const parsed = MoreInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const params = parseBoardParams(new URLSearchParams(parsed.data.query));
  try {
    const res = await loadBoardCell(agent, params, await getLocale(), {
      lane: parsed.data.lane,
      col: parsed.data.col,
      offset: parsed.data.offset,
    });
    if ("error" in res) return { ok: false, error: "load" };
    return { ok: true, cards: res.cards, total: res.total };
  } catch {
    return { ok: false, error: "load" };
  }
}

export type PreviewResult = { ok: true; preview: BoardPreview } | { ok: false; error: "session" | "invalid" | "not_found" };

/** Ultime voci del thread per il pannello di anteprima. */
export async function ticketPreviewAction(ticketId: number): Promise<PreviewResult> {
  const agent = await currentAgent();
  if (!agent) return { ok: false, error: "session" };
  const id = z.number().int().positive().safeParse(ticketId);
  if (!id.success) return { ok: false, error: "invalid" };
  const preview = await ticketPreview(agent, id.data, await getLocale());
  return preview ? { ok: true, preview } : { ok: false, error: "not_found" };
}
