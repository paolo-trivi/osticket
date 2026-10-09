"use client";

import { useTranslations } from "next-intl";
import { Fragment, useCallback, useMemo, useRef, useState } from "react";

import { InfoIcon } from "@/icons";
import { canMoveAnywhere, dropBlock } from "@/server/domain/board/grouping";
import { RECENT_CLOSED_DAYS } from "@/server/domain/board/params";
import {
  cellKey,
  type BoardCard,
  type BoardColumn,
  type BoardData,
  type BoardPreview,
  type MoveErrorCode,
} from "@/server/domain/board/types";
import { cn } from "@/utils";

import BoardCardItem from "./BoardCardItem";
import BoardCellView, { type DropState } from "./BoardCellView";
import BoardColumnHeader from "./BoardColumnHeader";
import BoardPreviewPanel from "./BoardPreviewPanel";
import BoardToast, { type ToastMessage } from "./BoardToast";
import CardMenu, { blockReason } from "./CardMenu";
import LaneHeader from "./LaneHeader";
import {
  appendCards,
  applyMove,
  cellOf,
  mergeCells,
  movedCard,
  type Cells,
} from "./cells";
import { useBoardDrag } from "./useBoardDrag";

export type { MoveErrorCode };

export interface BoardActions {
  move: (input: {
    ticketId: number;
    statusId: number;
  }) => Promise<
    | { ok: true; ticketId: number; statusId: number }
    | { ok: false; error: MoveErrorCode }
  >;
  loadMore: (input: {
    query: string;
    lane: string;
    col: string;
    offset: number;
  }) => Promise<
    | { ok: true; cards: BoardCard[]; total: number }
    | { ok: false; error: string }
  >;
  preview: (
    ticketId: number,
  ) => Promise<
    { ok: true; preview: BoardPreview } | { ok: false; error: string }
  >;
}

/**
 * Board Kanban (stile Jira): colonne × swimlane, card con trascinamento (solo raggruppamento per stato),
 * spostamento ottimistico con rollback, "carica altri" per cella, anteprima laterale.
 */
export default function BoardView({
  data,
  query,
  olderHref,
  actions,
  pending,
}: {
  data: BoardData;
  /** search params correnti della board (per "carica altri") */
  query: string;
  /** link alla stessa vista con anche i chiusi meno recenti */
  olderHref: string;
  actions: BoardActions;
  /** navigazione in corso (cambio filtri) */
  pending: boolean;
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
  const [moving, setMoving] = useState<ReadonlySet<number>>(new Set());
  const [loadingCell, setLoadingCell] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const toastId = useRef(0);

  const columns = data.columns;
  const colByKey = useMemo(
    () => new Map(columns.map((c) => [c.key, c])),
    [columns],
  );
  const statusColumns = data.dragEnabled ? columns : [];
  const hasLanes = data.lane !== "none";

  const closePreview = useCallback(() => setPreviewId(null), []);
  const showToast = useCallback(
    (msg: Omit<ToastMessage, "id">) =>
      setToast({ ...msg, id: ++toastId.current }),
    [],
  );
  const closeToast = useCallback(() => setToast(null), []);

  const findCard = useCallback(
    (id: number | null): BoardCard | null => {
      if (id === null) return null;
      for (const cell of Object.values(cells))
        for (const c of cell.cards) if (c.id === id) return c;
      return null;
    },
    [cells],
  );

  const move = useCallback(
    async (card: BoardCard, column: BoardColumn) => {
      const block = dropBlock(card, column, card.lane);
      if (block === "same") return;
      if (block) {
        showToast({
          kind: "error",
          title: t("errors.title", { number: card.number }),
          message: blockReason((k) => t(`drag.${k}`), block),
        });
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
        res = await actions.move({
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
    [actions, showToast, t],
  );

  const onDrop = useCallback(
    (card: BoardCard, key: string) => {
      const [lane, col] = key.split("::");
      const column = colByKey.get(col);
      if (!column) return;
      const block = dropBlock(card, column, lane);
      if (block === "same") return;
      if (block) {
        showToast({
          kind: "error",
          title: t("errors.title", { number: card.number }),
          message: blockReason((k) => t(`drag.${k}`), block),
        });
        return;
      }
      void move(card, column);
    },
    [colByKey, move, showToast, t],
  );

  const { drag, start, shouldSuppressClick, ghostRef } = useBoardDrag({
    enabled: data.dragEnabled,
    scroller,
    onDrop,
  });

  const loadMore = async (lane: string, col: string) => {
    const key = cellKey(lane, col);
    setLoadingCell(key);
    try {
      const res = await actions.loadMore({
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

  const columnTotal = (col: string) =>
    data.lanes.reduce(
      (n, lane) => n + (cells[cellKey(lane.key, col)]?.total ?? 0),
      0,
    );

  const dropStateFor = (
    laneKey: string,
    column: BoardColumn,
  ): { state: DropState; reason?: string } => {
    if (!drag) return { state: "idle" };
    const key = cellKey(laneKey, column.key);
    if (key === cellOf(drag.card)) return { state: "source" };
    const block = dropBlock(drag.card, column, laneKey);
    if (block === "same") return { state: "idle" };
    if (block)
      return {
        state: "blocked",
        reason: blockReason((k) => t(`drag.${k}`), block),
      };
    return { state: drag.over === key ? "over" : "allowed" };
  };

  const anyMovable = useMemo(
    () =>
      data.dragEnabled &&
      Object.values(data.cells).some((cell) =>
        cell.cards.some((c) => canMoveAnywhere(c, columns)),
      ),
    [data, columns],
  );
  const previewCard = findCard(previewId);

  return (
    <div
      className={cn(
        "relative transition-opacity",
        pending && "pointer-events-none opacity-60",
      )}
      aria-busy={pending}
    >
      {!data.dragEnabled && (
        <p className="mb-3 flex items-start gap-2 text-theme-sm text-gray-500 dark:text-gray-400">
          <InfoIcon
            viewBox="0 0 24 24"
            className="mt-0.5 size-4 shrink-0"
            aria-hidden
          />
          {t("drag.disabledGroup")}
        </p>
      )}
      {data.dragEnabled && data.total > 0 && !anyMovable && (
        <p className="mb-3 flex items-start gap-2 text-theme-sm text-gray-500 dark:text-gray-400">
          <InfoIcon
            viewBox="0 0 24 24"
            className="mt-0.5 size-4 shrink-0"
            aria-hidden
          />
          {t("state.readOnly")}
        </p>
      )}
      {data.total === 0 && (
        <p className="mb-3 rounded-xl border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          {t("state.empty")}
        </p>
      )}

      {columns.length > 0 && (
        <div
          ref={scroller}
          className="relative -mx-4 custom-scrollbar snap-x snap-mandatory scroll-px-4 overflow-x-auto px-4 pb-3 [contain:inline-size] md:mx-0 md:snap-none md:px-0"
        >
          <div
            className="grid gap-3"
            style={{
              gridTemplateColumns: `repeat(${columns.length}, min(84vw, 18.5rem))`,
            }}
          >
            {columns.map((col) => {
              const block = drag
                ? dropBlock(drag.card, col, drag.card.lane)
                : null;
              return (
                <BoardColumnHeader
                  key={`h-${col.key}`}
                  column={col}
                  count={columnTotal(col.key)}
                  dimmed={!!drag && block !== null && block !== "same"}
                  isMeLabel
                />
              );
            })}

            {data.lanes.map((lane) => {
              const laneId = `board-lane-${lane.key}`;
              const isCollapsed = collapsed.has(lane.key);
              return (
                <Fragment key={lane.key}>
                  {hasLanes && (
                    <LaneHeader
                      lane={lane}
                      collapsed={isCollapsed}
                      controls={laneId}
                      onToggle={() =>
                        setCollapsed((s) => {
                          const n = new Set(s);
                          if (n.has(lane.key)) n.delete(lane.key);
                          else n.add(lane.key);
                          return n;
                        })
                      }
                    />
                  )}
                  {!isCollapsed &&
                    columns.map((col) => {
                      const key = cellKey(lane.key, col.key);
                      const cell = cells[key] ?? {
                        cards: [],
                        total: 0,
                        olderClosed: 0,
                      };
                      const ds = dropStateFor(lane.key, col);
                      return (
                        <div
                          key={key}
                          id={col === columns[0] ? laneId : undefined}
                          className="min-w-0"
                        >
                          <BoardCellView
                            cellKey={key}
                            column={col}
                            total={cell.total}
                            shown={cell.cards.length}
                            olderClosed={cell.olderClosed}
                            dropState={ds.state}
                            blockedReason={ds.reason}
                            loading={loadingCell === key}
                            onLoadMore={() => void loadMore(lane.key, col.key)}
                            olderHref={olderHref}
                            recentDays={RECENT_CLOSED_DAYS}
                            sourceNoClosed={!data.sourceHasClosed}
                          >
                            {cell.cards.map((card) => {
                              const movable =
                                data.dragEnabled &&
                                !moving.has(card.id) &&
                                canMoveAnywhere(card, columns);
                              return (
                                <BoardCardItem
                                  key={card.id}
                                  card={card}
                                  draggable={movable}
                                  dragging={drag?.card.id === card.id}
                                  pending={moving.has(card.id)}
                                  onPointerDown={
                                    movable ? (e) => start(e, card) : undefined
                                  }
                                  onOpen={() => setPreviewId(card.id)}
                                  shouldSuppressClick={shouldSuppressClick}
                                  menu={
                                    <CardMenu
                                      card={card}
                                      columns={statusColumns}
                                      moveEnabled={
                                        data.dragEnabled && !moving.has(card.id)
                                      }
                                      onMove={(c) => void move(card, c)}
                                      onPreview={() => setPreviewId(card.id)}
                                    />
                                  }
                                />
                              );
                            })}
                          </BoardCellView>
                        </div>
                      );
                    })}
                </Fragment>
              );
            })}
          </div>
        </div>
      )}

      {drag && (
        <div
          ref={ghostRef}
          aria-hidden
          className="pointer-events-none fixed z-99999"
          style={{
            left: drag.left,
            top: drag.top,
            width: drag.width,
            transform: `translate3d(${drag.dx}px, ${drag.dy}px, 0) rotate(2deg)`,
          }}
        >
          <BoardCardItem card={drag.card} draggable={false} ghost />
        </div>
      )}

      <BoardPreviewPanel
        card={previewCard}
        statusColumns={statusColumns}
        moveEnabled={
          data.dragEnabled && !!previewCard && !moving.has(previewCard.id)
        }
        onMove={(c, col) => void move(c, col)}
        onClose={closePreview}
        loadPreview={actions.preview}
      />
      <BoardToast toast={toast} onClose={closeToast} />
    </div>
  );
}
