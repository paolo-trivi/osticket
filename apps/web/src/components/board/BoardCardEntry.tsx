"use client";

import type React from "react";

import type { BoardCard, BoardColumn } from "@/server/domain/board/types";

import BoardCardItem from "./BoardCardItem";
import CardMenu from "./CardMenu";

interface BoardCardEntryProps {
  card: BoardCard;
  /** la card si può trascinare */
  movable: boolean;
  dragging: boolean;
  /** spostamento in corso sul server */
  pending: boolean;
  /** colonne di stato proposte da "Sposta in…" (vuoto se il raggruppamento non è per stato) */
  statusColumns: BoardColumn[];
  moveEnabled: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLElement>, card: BoardCard) => void;
  onPreview: (id: number) => void;
  onMove: (card: BoardCard, column: BoardColumn) => void;
  shouldSuppressClick: () => boolean;
}

/** Card di una cella con il suo menu (anteprima, apertura, "Sposta in…"). */
export default function BoardCardEntry({
  card,
  movable,
  dragging,
  pending,
  statusColumns,
  moveEnabled,
  onPointerDown,
  onPreview,
  onMove,
  shouldSuppressClick,
}: BoardCardEntryProps) {
  return (
    <BoardCardItem
      card={card}
      draggable={movable}
      dragging={dragging}
      pending={pending}
      onPointerDown={movable ? (e) => onPointerDown(e, card) : undefined}
      onOpen={() => onPreview(card.id)}
      shouldSuppressClick={shouldSuppressClick}
      menu={
        <CardMenu
          card={card}
          columns={statusColumns}
          moveEnabled={moveEnabled}
          onMove={(c) => onMove(card, c)}
          onPreview={() => onPreview(card.id)}
        />
      }
    />
  );
}
