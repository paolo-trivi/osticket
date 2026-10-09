import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BoardClient from "@/components/board/BoardClient";
import { boardPriorities, boardSources, loadBoard } from "@/server/domain/board/board";
import { parseBoardParams } from "@/server/domain/board/params";
import type { BoardColumn, BoardData } from "@/server/domain/board/types";

import { requireAgent } from "../../guard";
import { loadMoreCardsAction, moveTicketAction, ticketPreviewAction } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "board" });
  return { title: t("pageTitle") };
}

/** Board Kanban dei ticket (`/agent/board`): vista condivisibile tramite i search params. */
export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const bp = parseBoardParams(await searchParams);
  const [data, sources, priorities, t, tq] = await Promise.all([
    loadBoard(agent, bp, locale),
    boardSources(agent),
    boardPriorities(),
    getTranslations("board"),
    getTranslations("queues"),
  ]);

  // Titoli tradotti: colonne/swimlane speciali e nomi delle code (come la lista ticket)
  const title = (c: BoardColumn): BoardColumn => (c.special ? { ...c, title: t(`special.${c.special}`) } : c);
  const queueName = (raw: string) => (raw && tq.has(raw) ? tq(raw) : raw);
  const view: BoardData = {
    ...data,
    columns: data.columns.map(title),
    lanes: data.lanes.map((l) => ({ ...l, ...title(l) })),
  };
  const sourceTitle = bp.source === "all" ? t("toolbar.allVisible") : queueName(data.sourceTitle);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{t("pageTitle")}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {sourceTitle} · {t("count", { total: data.total })}
          </p>
        </div>
      </header>
      <BoardClient
        params={bp}
        data={data.error ? null : view}
        sources={sources.map((s) => ({ ...s, title: queueName(s.title) }))}
        priorities={priorities}
        actions={{
          move: moveTicketAction,
          loadMore: loadMoreCardsAction,
          preview: ticketPreviewAction,
        }}
        toolbarSlot={
          data.error ? (
            <div className="rounded-xl border border-warning-500/30 bg-warning-50 p-4 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/15 dark:text-warning-400">
              <p>{t(`state.${data.error}`)}</p>
            </div>
          ) : undefined
        }
      />
    </div>
  );
}
