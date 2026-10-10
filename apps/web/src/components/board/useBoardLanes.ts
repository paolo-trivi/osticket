"use client";

import { useCallback, useState } from "react";

/** Swimlane chiuse dall'utente (solo stato locale della vista). */
export function useBoardLanes() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (key: string) =>
      setCollapsed((s) => {
        const n = new Set(s);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return n;
      }),
    [],
  );
  return { collapsed, toggle };
}
