"use client";

import { useTranslations } from "next-intl";
import { useCallback, useMemo, useRef, useState } from "react";

import { canMoveAnywhere, dropBlock } from "@/server/domain/board/grouping";
import { RECENT_CLOSED_DAYS } from "@/server/domain/board/params";
import { cellKey, type BoardCell, type BoardColumn, type BoardData } from "@/server/domain/board/types";
import { cn } from "@/utils";

import BoardCardEntry from "./BoardCardEntry";
import BoardCellView, { type DropState } from "./BoardCellView";
import BoardColumnHeader from "./BoardColumnHeader";
import BoardDragGhost from "./BoardDragGhost";
import BoardGrid from "./BoardGrid";
import BoardLaneRow from "./BoardLaneRow";
import BoardNotices from "./BoardNotices";
import BoardPreviewPanel from "./BoardPreviewPanel";
import BoardToast from "./BoardToast";
import { blockReason } from "./CardMenu";
import { cellOf } from "./cells";
import type { BoardActions } from "./types";
import { useBoardCells } from "./useBoardCells";
import { useBoardDrag } from "./useBoardDrag";
import { useBoardLanes } from "./useBoardLanes";
import { useBoardMove } from "./useBoardMove";
import { useBoardToast } from "./useBoardToast";

const EMPTY_CELL: BoardCell = { cards: [], total: 0, olderClosed: 0 };

/**
 * Board Kanban (stile Jira): colonne × swimlane, card con trascinamento (solo raggruppamento per stato),
 * spostamento ottimistico con rollback, "carica altri" per cella, anteprima laterale.
 * Contenitore: lo stato sta negli hook useBoard…, la resa nei sotto-componenti.
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
  const { toast, showToast, closeToast } = useBoardToast();
  const { cells, setCells, loadingCell, loadMore, findCard, columnTotal } = useBoardCells({
    data,
    query,
    loadMoreAction: actions.loadMore,
    showToast,
  });
  const columns = data.columns;
  const { moving, move, onDrop } = useBoardMove({ columns, setCells, moveAction: actions.move, showToast });
  const { collapsed, toggle: toggleLane } = useBoardLanes();
  const [previewId, setPreviewId] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const statusColumns = data.dragEnabled ? columns : [];
  const hasLanes = data.lane !== "none";
  const closePreview = useCallback(() => setPreviewId(null), []);

  const { drag, start, shouldSuppressClick, ghostRef } = useBoardDrag({
    enabled: data.dragEnabled,
    scroller,
    onDrop,
  });

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
      <BoardNotices dragEnabled={data.dragEnabled} total={data.total} anyMovable={anyMovable} />

      {columns.length > 0 && (
        <BoardGrid scrollerRef={scroller} columnCount={columns.length}>
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
            return (
              <BoardLaneRow
                key={lane.key}
                lane={lane}
                showHeader={hasLanes}
                collapsed={collapsed.has(lane.key)}
                laneId={laneId}
                onToggle={toggleLane}
              >
                {columns.map((col) => {
                  const key = cellKey(lane.key, col.key);
                  const cell = cells[key] ?? EMPTY_CELL;
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
                        {cell.cards.map((card) => (
                          <BoardCardEntry
                            key={card.id}
                            card={card}
                            movable={data.dragEnabled && !moving.has(card.id) && canMoveAnywhere(card, columns)}
                            dragging={drag?.card.id === card.id}
                            pending={moving.has(card.id)}
                            statusColumns={statusColumns}
                            moveEnabled={data.dragEnabled && !moving.has(card.id)}
                            onPointerDown={start}
                            onPreview={setPreviewId}
                            onMove={(c, column) => void move(c, column)}
                            shouldSuppressClick={shouldSuppressClick}
                          />
                        ))}
                      </BoardCellView>
                    </div>
                  );
                })}
              </BoardLaneRow>
            );
          })}
        </BoardGrid>
      )}

      {drag && (
        <BoardDragGhost
          card={drag.card}
          left={drag.left}
          top={drag.top}
          width={drag.width}
          dx={drag.dx}
          dy={drag.dy}
          ghostRef={ghostRef}
        />
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
