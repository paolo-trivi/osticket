import type { ReactNode, Ref } from "react";

interface BoardGridProps {
  /** contenitore a scorrimento orizzontale (usato dal drag per lo scorrimento automatico) */
  scrollerRef: Ref<HTMLDivElement>;
  columnCount: number;
  children: ReactNode;
}

/** Griglia della board: una colonna CSS per colonna della board, scorrimento orizzontale (a scatti su mobile). */
export default function BoardGrid({ scrollerRef, columnCount, children }: BoardGridProps) {
  return (
    <div
      ref={scrollerRef}
      className="relative -mx-4 custom-scrollbar snap-x snap-mandatory scroll-px-4 overflow-x-auto px-4 pb-3 [contain:inline-size] md:mx-0 md:snap-none md:px-0"
    >
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${columnCount}, min(84vw, 18.5rem))`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
