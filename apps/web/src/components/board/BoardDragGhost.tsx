import type { Ref } from "react";

import type { BoardCard } from "@/server/domain/board/types";

import BoardCardItem from "./BoardCardItem";

interface BoardDragGhostProps {
  card: BoardCard;
  /** posizione iniziale della card e spostamento del puntatore (aggiornato poi direttamente da useBoardDrag) */
  left: number;
  top: number;
  width: number;
  dx: number;
  dy: number;
  ghostRef: Ref<HTMLDivElement>;
}

/** Copia della card che segue il puntatore durante il trascinamento. */
export default function BoardDragGhost({ card, left, top, width, dx, dy, ghostRef }: BoardDragGhostProps) {
  return (
    <div
      ref={ghostRef}
      aria-hidden
      className="pointer-events-none fixed z-99999"
      style={{
        left,
        top,
        width,
        transform: `translate3d(${dx}px, ${dy}px, 0) rotate(2deg)`,
      }}
    >
      <BoardCardItem card={card} draggable={false} ghost />
    </div>
  );
}
