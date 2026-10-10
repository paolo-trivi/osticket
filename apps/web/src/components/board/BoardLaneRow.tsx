import { Fragment, type ReactNode } from "react";

import type { BoardLane } from "@/server/domain/board/types";

import LaneHeader from "./LaneHeader";

interface BoardLaneRowProps {
  lane: BoardLane;
  /** mostra l'intestazione della swimlane (raggruppamento per righe attivo) */
  showHeader: boolean;
  collapsed: boolean;
  /** id della prima cella della riga (aria-controls dell'intestazione) */
  laneId: string;
  onToggle: (key: string) => void;
  /** celle della riga, una per colonna */
  children: ReactNode;
}

/** Riga della griglia per una swimlane: intestazione comprimibile e celle (nascoste se compressa). */
export default function BoardLaneRow({ lane, showHeader, collapsed, laneId, onToggle, children }: BoardLaneRowProps) {
  return (
    <Fragment>
      {showHeader && (
        <LaneHeader
          lane={lane}
          collapsed={collapsed}
          controls={laneId}
          onToggle={() => onToggle(lane.key)}
        />
      )}
      {!collapsed && children}
    </Fragment>
  );
}
