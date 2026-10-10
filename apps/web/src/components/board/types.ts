import type { BoardCard, BoardPreview, MoveErrorCode } from "@/server/domain/board/types";

/** Server action della board passate dalla pagina al client. */
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
