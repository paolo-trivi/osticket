"use client";

import { useEffect, useTransition } from "react";

import { useRouter } from "@/i18n/navigation";
import {
  BOARD_PARAM_KEYS,
  boardHref,
  boardSearchParams,
  parseBoardParams,
  type BoardParams,
} from "@/server/domain/board/params";
import type { BoardData, BoardSourceOption } from "@/server/domain/board/types";

import BoardToolbar, { type PriorityChoice } from "./BoardToolbar";
import BoardView, { type BoardActions } from "./BoardView";

const PREFS_KEY = "tailticket.board.view";

/**
 * Contenitore client della board: le scelte (sorgente, colonne, swimlane, filtri) stanno nell'URL; l'ultima vista è
 * ricordata in localStorage (senza ricerca testuale) e ripristinata quando si apre /agent/board senza parametri.
 */
export default function BoardClient({
  params,
  data,
  sources,
  priorities,
  actions,
  toolbarSlot,
}: {
  params: BoardParams;
  data: BoardData | null;
  sources: BoardSourceOption[];
  priorities: PriorityChoice[];
  actions: BoardActions;
  /** messaggio d'errore della vista (reso dal server) */
  toolbarSlot?: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const query = boardSearchParams(params).toString();

  const navigate = (next: BoardParams) =>
    startTransition(() =>
      router.replace(boardHref(parseBoardParams(boardSearchParams(next))), {
        scroll: false,
      }),
    );

  // Ripristino dell'ultima vista (solo se l'URL non contiene scelte esplicite)
  useEffect(() => {
    try {
      const current = new URLSearchParams(window.location.search);
      if (BOARD_PARAM_KEYS.some((k) => current.has(k))) return;
      const saved = window.localStorage.getItem(PREFS_KEY);
      if (!saved) return;
      const href = boardHref(parseBoardParams(new URLSearchParams(saved)));
      if (href !== "/agent/board")
        startTransition(() => router.replace(href, { scroll: false }));
    } catch {
      /* storage non disponibile */
    }
    // solo al primo caricamento
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Memorizzazione della vista corrente (la ricerca e i chiusi precedenti non si ricordano)
  const remembered = boardSearchParams({
    ...params,
    q: "",
    older: false,
  }).toString();
  useEffect(() => {
    try {
      window.localStorage.setItem(PREFS_KEY, remembered);
    } catch {
      /* storage non disponibile */
    }
  }, [remembered]);

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-gray-200 bg-white p-4 sm:p-5 dark:border-gray-800 dark:bg-white/3">
        <BoardToolbar
          params={params}
          sources={sources}
          priorities={priorities}
          onChange={navigate}
        />
      </div>
      {toolbarSlot}
      {data && (
        <BoardView
          data={data}
          query={query}
          olderHref={boardHref({ ...params, older: true })}
          actions={actions}
          pending={pending}
        />
      )}
    </div>
  );
}
