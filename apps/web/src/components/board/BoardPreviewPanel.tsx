"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Link } from "@/i18n/navigation";
import { CloseLineIcon, PadlockIcon } from "@/icons";
import { dropBlock } from "@/server/domain/board/grouping";
import type {
  BoardCard,
  BoardColumn,
  BoardPreview,
} from "@/server/domain/board/types";
import { cn } from "@/utils";

import AssigneeAvatar from "./AssigneeAvatar";
import { blockReason } from "./CardMenu";
import PriorityPill from "./PriorityPill";

type Loaded = { id: number; preview: BoardPreview | null; error: boolean };

/**
 * Pannello laterale di anteprima (come il dettaglio rapido di Jira): dati della card, ultime voci del thread e
 * spostamento di stato; "Apri il ticket" porta alla vista completa.
 */
export default function BoardPreviewPanel({
  card,
  statusColumns,
  moveEnabled,
  onMove,
  onClose,
  loadPreview,
}: {
  loadPreview: (
    ticketId: number,
  ) => Promise<
    { ok: true; preview: BoardPreview } | { ok: false; error: string }
  >;
  card: BoardCard | null;
  statusColumns: BoardColumn[];
  moveEnabled: boolean;
  onMove: (card: BoardCard, column: BoardColumn) => void;
  onClose: () => void;
}) {
  const t = useTranslations("board.preview");
  const tc = useTranslations("board.card");
  const td = useTranslations("board.drag");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const cardId = card?.id ?? null;

  useEffect(() => {
    if (cardId === null) return;
    let alive = true;
    loadPreview(cardId)
      .then(
        (r) =>
          alive &&
          setLoaded({
            id: cardId,
            preview: r.ok ? r.preview : null,
            error: !r.ok,
          }),
      )
      .catch(
        () => alive && setLoaded({ id: cardId, preview: null, error: true }),
      );
    return () => {
      alive = false;
    };
  }, [cardId, loadPreview]);

  useEffect(() => {
    if (cardId === null) return;
    const prev = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [cardId, onClose]);

  if (!card) return null;
  const current = loaded?.id === card.id ? loaded : null;

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-start justify-between gap-4 py-2">
      <dt className="shrink-0 text-theme-sm text-gray-500 dark:text-gray-400">
        {label}
      </dt>
      <dd className="min-w-0 text-end text-theme-sm text-gray-800 dark:text-white/90">
        {value}
      </dd>
    </div>
  );

  return (
    <div className="fixed inset-0 z-99999" role="presentation">
      <button
        type="button"
        aria-label={t("close")}
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-gray-900/30 backdrop-blur-[2px] dark:bg-black/50"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="board-preview-title"
        className="absolute inset-y-0 end-0 flex w-full max-w-md flex-col border-s border-gray-200 bg-white shadow-theme-xl dark:border-gray-800 dark:bg-gray-dark"
      >
        <header className="flex items-start gap-3 border-b border-gray-100 px-5 py-4 dark:border-gray-800">
          <div className="min-w-0 flex-1">
            <p className="font-mono flex items-center gap-1.5 text-theme-xs text-gray-500 dark:text-gray-400">
              #{card.number}
              {card.lockedBy && (
                <span className="font-sans inline-flex items-center gap-1 text-warning-600 dark:text-warning-400">
                  <PadlockIcon className="size-3.5" aria-hidden />
                  {tc("locked", { name: card.lockedBy })}
                </span>
              )}
            </p>
            <h2
              id="board-preview-title"
              className="mt-1 text-lg font-semibold break-words text-gray-800 dark:text-white/90"
            >
              {card.subject || "—"}
            </h2>
          </div>
          <button
            ref={closeBtn}
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-3 focus-visible:ring-brand-500/30 focus-visible:outline-hidden dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-200"
          >
            <CloseLineIcon viewBox="0 0 17 16" className="size-5" aria-hidden />
          </button>
        </header>

        <div className="custom-scrollbar flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            {(card.overdue || card.dueSoon) && (
              <span
                className={`text-theme-xs ${cn(
                  "rounded-full px-2 py-0.5 font-medium",
                  card.overdue
                    ? "bg-error-50 text-error-600 dark:bg-error-500/15 dark:text-error-400"
                    : "bg-warning-50 text-warning-700 dark:bg-warning-500/15 dark:text-warning-400",
                )}`}
              >
                {card.overdue ? tc("overdue") : tc("dueSoon")}
              </span>
            )}
            <PriorityPill priority={card.priority} />
          </div>

          <dl className="mt-3 divide-y divide-gray-100 dark:divide-gray-800">
            {row(t("status"), card.status)}
            {row(
              t("assignee"),
              <span className="inline-flex items-center gap-2">
                {card.assignee?.name ?? tc("unassigned")}
                <AssigneeAvatar assignee={card.assignee} />
              </span>,
            )}
            {row(t("user"), card.user)}
            {card.dept && row(t("dept"), card.dept)}
            {card.topic && row(t("topic"), card.topic)}
            {card.dueLabel && row(t("due"), card.dueLabel)}
            {row(
              t("updated"),
              <span title={card.updatedTitle}>{card.updatedLabel}</span>,
            )}
          </dl>

          {moveEnabled && (
            <div className="mt-4">
              <h3 className="text-theme-xs font-medium tracking-wide text-gray-500 uppercase dark:text-gray-400">
                {tc("moveTo")}
              </h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {statusColumns.map((col) => {
                  const block = dropBlock(card, col, card.lane);
                  return (
                    <button
                      key={col.key}
                      type="button"
                      disabled={block !== null}
                      title={blockReason(td, block)}
                      aria-pressed={block === "same"}
                      onClick={() => onMove(card, col)}
                      className={`text-theme-sm ${cn(
                        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 ring-1 transition",
                        block === "same"
                          ? "bg-brand-50 font-medium text-brand-600 ring-brand-200 dark:bg-brand-500/15 dark:text-brand-400 dark:ring-brand-800"
                          : "text-gray-700 ring-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-white/5",
                      )}`}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "size-2 rounded-full",
                          col.state === "closed"
                            ? "bg-success-500"
                            : "bg-blue-light-500",
                        )}
                      />
                      {col.title}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <section className="mt-6">
            <h3 className="text-theme-xs font-medium tracking-wide text-gray-500 uppercase dark:text-gray-400">
              {t("lastMessages")}
            </h3>
            {!current ? (
              <p className="mt-3 text-theme-sm text-gray-500 dark:text-gray-400">
                {t("loading")}
              </p>
            ) : current.error || !current.preview ? (
              <p className="mt-3 text-theme-sm text-error-600 dark:text-error-400">
                {t("error")}
              </p>
            ) : current.preview.entries.length === 0 ? (
              <p className="mt-3 text-theme-sm text-gray-500 dark:text-gray-400">
                {t("noMessages")}
              </p>
            ) : (
              <ol className="mt-3 space-y-3">
                {current.preview.entries.map((e) => (
                  <li
                    key={e.id}
                    className={cn(
                      "rounded-xl border p-3",
                      e.type === "R" &&
                        "border-brand-100 bg-brand-25 dark:border-brand-500/20 dark:bg-brand-500/5",
                      e.type === "N" &&
                        "border-warning-100 bg-warning-25 dark:border-warning-500/20 dark:bg-warning-500/5",
                      e.type === "M" &&
                        "border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-white/2",
                    )}
                  >
                    <p className="flex items-center justify-between gap-2 text-theme-xs text-gray-500 dark:text-gray-400">
                      <span className="truncate font-medium text-gray-700 dark:text-gray-300">
                        {e.poster}
                      </span>
                      <span title={e.whenTitle} className="shrink-0">
                        {e.when}
                      </span>
                    </p>
                    <p className="mt-1 text-theme-sm break-words whitespace-pre-line text-gray-700 dark:text-gray-300">
                      {e.excerpt}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <footer className="border-t border-gray-100 px-5 py-4 dark:border-gray-800">
          <Link
            href={`/agent/tickets/${card.id}`}
            className="flex w-full items-center justify-center rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600"
          >
            {t("open")}
          </Link>
        </footer>
      </aside>
    </div>
  );
}
