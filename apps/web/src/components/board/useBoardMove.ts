"use client";

import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import { dropBlock, type DropBlock } from "@/server/domain/board/grouping";
import type { BoardCard, BoardColumn } from "@/server/domain/board/types";

import { blockReason } from "./CardMenu";
import { applyMove, cellOf, movedCard, type Cells } from "./cells";
import type { BoardActions } from "./types";
import type { ShowToast } from "./useBoardToast";

/**
 * Cambio stato di una card (menu, anteprima o rilascio del drag): spostamento ottimistico, chiamata al server,
 * rollback e notifica in caso di errore. `moving` contiene le card in attesa di risposta.
 */
export function useBoardMove({
  columns,
  setCells,
  moveAction,
  showToast,
}: {
  columns: BoardColumn[];
  setCells: Dispatch<SetStateAction<Cells>>;
  moveAction: BoardActions["move"];
  showToast: ShowToast;
}) {
  const t = useTranslations("board");
  const [moving, setMoving] = useState<ReadonlySet<number>>(new Set());
  const colByKey = useMemo(
    () => new Map(columns.map((c) => [c.key, c])),
    [columns],
  );

  const showBlocked = useCallback(
    (card: BoardCard, block: DropBlock) =>
      showToast({
        kind: "error",
        title: t("errors.title", { number: card.number }),
        message: blockReason((k) => t(`drag.${k}`), block),
      }),
    [showToast, t],
  );

  const move = useCallback(
    async (card: BoardCard, column: BoardColumn) => {
      const block = dropBlock(card, column, card.lane);
      if (block === "same") return;
      if (block) {
        showBlocked(card, block);
        return;
      }
      const from = cellOf(card);
      const moved = movedCard(
        card,
        column.key,
        column.statusId!,
        column.state!,
        column.title,
      );
      const to = cellOf(moved);
      setCells((c) => applyMove(c, from, to, moved));
      setMoving((s) => new Set(s).add(card.id));
      let res: Awaited<ReturnType<BoardActions["move"]>>;
      try {
        res = await moveAction({
          ticketId: card.id,
          statusId: column.statusId!,
        });
      } catch {
        res = { ok: false, error: "internal" };
      }
      setMoving((s) => {
        const n = new Set(s);
        n.delete(card.id);
        return n;
      });
      if (!res.ok) {
        // rollback: la card torna nella cella di partenza con i dati originali
        setCells((c) => applyMove(c, to, from, card));
        const detail = t.has(`errors.${res.error}`)
          ? t(`errors.${res.error}`)
          : t("errors.internal");
        showToast({
          kind: "error",
          title: t("errors.title", { number: card.number }),
          message: detail,
        });
        return;
      }
      showToast({
        kind: "success",
        title: t("drag.moved", { number: card.number, status: column.title }),
      });
    },
    [moveAction, setCells, showBlocked, showToast, t],
  );

  /** Rilascio del drag su una cella (`lane::col`). */
  const onDrop = useCallback(
    (card: BoardCard, key: string) => {
      const [lane, col] = key.split("::");
      const column = colByKey.get(col);
      if (!column) return;
      const block = dropBlock(card, column, lane);
      if (block === "same") return;
      if (block) {
        showBlocked(card, block);
        return;
      }
      void move(card, column);
    },
    [colByKey, move, showBlocked],
  );

  return { moving, move, onDrop };
}
