"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { cellKey, type BoardCard, type BoardData } from "@/server/domain/board/types";

import { appendCards, mergeCells, type Cells } from "./cells";
import type { BoardActions } from "./types";
import type { ShowToast } from "./useBoardToast";

/**
 * Stato client delle celle della board: allineamento ai nuovi dati del server e "carica altri" per cella.
 * Gli spostamenti ottimistici passano da useBoardMove tramite `setCells`.
 */
export function useBoardCells({
  data,
  query,
  loadMoreAction,
  showToast,
}: {
  data: BoardData;
  /** search params correnti della board (per "carica altri") */
  query: string;
  loadMoreAction: BoardActions["loadMore"];
  showToast: ShowToast;
}) {
  const t = useTranslations("board");
  const [cells, setCells] = useState<Cells>(data.cells);
  const [prev, setPrev] = useState({ data, query });
  // Nuovi dati dal server: stessa vista → fusione (mantiene le card caricate in più); vista diversa → sostituzione
  if (prev.data !== data) {
    setPrev({ data, query });
    setCells((c) =>
      prev.query === query ? mergeCells(data.cells, c) : data.cells,
    );
  }
  const [loadingCell, setLoadingCell] = useState<string | null>(null);

  const findCard = useCallback(
    (id: number | null): BoardCard | null => {
      if (id === null) return null;
      for (const cell of Object.values(cells))
        for (const c of cell.cards) if (c.id === id) return c;
      return null;
    },
    [cells],
  );

  const loadMore = async (lane: string, col: string) => {
    const key = cellKey(lane, col);
    setLoadingCell(key);
    try {
      const res = await loadMoreAction({
        query,
        lane,
        col,
        offset: cells[key]?.cards.length ?? 0,
      });
      if (res.ok) setCells((c) => appendCards(c, key, res.cards, res.total));
      else showToast({ kind: "error", title: t("errors.loadMore") });
    } catch {
      showToast({ kind: "error", title: t("errors.loadMore") });
    } finally {
      setLoadingCell(null);
    }
  };

  /** Totale di una colonna su tutte le swimlane. */
  const columnTotal = (col: string) =>
    data.lanes.reduce(
      (n, lane) => n + (cells[cellKey(lane.key, col)]?.total ?? 0),
      0,
    );

  return { cells, setCells, loadingCell, loadMore, findCard, columnTotal };
}
