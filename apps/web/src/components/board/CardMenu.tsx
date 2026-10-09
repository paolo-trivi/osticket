"use client";

import { useLocale, useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { isRtl } from "@/i18n/languages";
import type { Locale } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import { CheckLineIcon, MoreDotIcon } from "@/icons";
import { dropBlock, type DropBlock } from "@/server/domain/board/grouping";
import type { BoardCard, BoardColumn } from "@/server/domain/board/types";
import { cn } from "@/utils";

export function blockReason(
  t: (
    key: "reasonSame" | "reasonForbidden" | "reasonLane",
  ) => string,
  block: DropBlock,
): string | undefined {
  switch (block) {
    case "same":
      return t("reasonSame");
    case "forbidden":
      return t("reasonForbidden");
    case "lane":
      return t("reasonLane");
    default:
      return undefined;
  }
}

const MENU_WIDTH = 256;

/**
 * Menu della card: anteprima, apertura e "Sposta in…" (spostamento accessibile da tastiera, alternativa al drag).
 * Posizionato in `fixed` per non essere tagliato dal contenitore che scorre orizzontalmente.
 */
export default function CardMenu({
  card,
  columns,
  moveEnabled,
  onMove,
  onPreview,
}: {
  card: BoardCard;
  /** colonne di stato (vuoto se il raggruppamento non è per stato) */
  columns: BoardColumn[];
  moveEnabled: boolean;
  onMove: (column: BoardColumn) => void;
  onPreview: () => void;
}) {
  const t = useTranslations("board.card");
  const td = useTranslations("board.drag");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback((focus = true) => {
    setOpen(false);
    if (focus) button.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const rtl = isRtl(locale as Locale);
    const width = Math.min(MENU_WIDTH, window.innerWidth - 16);
    let left = rtl ? r.left : r.right - width;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    const height = menu.current?.offsetHeight ?? 240;
    const below = r.bottom + 4;
    const top =
      below + height > window.innerHeight - 8 && r.top - height - 4 > 8
        ? r.top - height - 4
        : below;
    setPos({ top, left });
  }, [open, locale]);

  useEffect(() => {
    if (!open) return;
    menu.current
      ?.querySelector<HTMLElement>("[role=menuitem]:not([aria-disabled=true])")
      ?.focus();
    const onDown = (e: PointerEvent) => {
      if (
        !menu.current?.contains(e.target as Node) &&
        !button.current?.contains(e.target as Node)
      )
        close(false);
    };
    const onScroll = () => close(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onScroll);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onScroll);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (
      e.key !== "ArrowDown" &&
      e.key !== "ArrowUp" &&
      e.key !== "Home" &&
      e.key !== "End"
    )
      return;
    e.preventDefault();
    const items = [
      ...(menu.current?.querySelectorAll<HTMLElement>(
        "[role=menuitem]:not([aria-disabled=true])",
      ) ?? []),
    ];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : e.key === "ArrowDown"
            ? (i + 1) % items.length
            : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const item =
    "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm text-gray-700 outline-hidden hover:bg-gray-100 focus-visible:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5 dark:focus-visible:bg-white/5";

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={t("actions", { number: card.number })}
        onClick={() => setOpen((o) => !o)}
        className="flex size-7 items-center justify-center rounded-lg text-gray-400 opacity-100 transition hover:bg-gray-100 hover:text-gray-700 focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-brand-500/30 focus-visible:outline-hidden aria-expanded:opacity-100 md:opacity-0 md:group-hover:opacity-100 dark:hover:bg-white/5 dark:hover:text-gray-200"
      >
        <MoreDotIcon viewBox="0 0 24 24" className="size-4" aria-hidden />
      </button>
      {open && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={t("actions", { number: card.number })}
          onKeyDown={onKeyDown}
          style={{
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            width: Math.min(
              MENU_WIDTH,
              typeof window === "undefined"
                ? MENU_WIDTH
                : window.innerWidth - 16,
            ),
          }}
          className="fixed z-99999 rounded-xl border border-gray-200 bg-white p-1.5 shadow-theme-lg dark:border-gray-800 dark:bg-gray-dark"
        >
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              close(false);
              onPreview();
            }}
          >
            {t("preview")}
          </button>
          <Link
            role="menuitem"
            href={`/agent/tickets/${card.id}`}
            className={item}
            onClick={() => close(false)}
          >
            {t("openTicket")}
          </Link>
          <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
          <p className="px-3 pt-1 pb-1 text-theme-xs font-medium tracking-wide text-gray-500 uppercase dark:text-gray-400">
            {t("moveTo")}
          </p>
          {!moveEnabled ? (
            <p className="px-3 pb-2 text-theme-xs text-gray-500 dark:text-gray-400">
              {td("statusOnly")}
            </p>
          ) : (
            columns.map((col) => {
              const block = dropBlock(card, col, card.lane);
              const current = block === "same";
              const disabled = block !== null;
              return (
                <button
                  key={col.key}
                  type="button"
                  role="menuitem"
                  aria-disabled={disabled}
                  title={blockReason(td, block)}
                  onClick={() => {
                    if (disabled) return;
                    close();
                    onMove(col);
                  }}
                  className={cn(
                    item,
                    disabled &&
                      "cursor-not-allowed opacity-50 hover:bg-transparent dark:hover:bg-transparent",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      col.state === "closed"
                        ? "bg-success-500"
                        : "bg-blue-light-500",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{col.title}</span>
                  {current && (
                    <>
                      <CheckLineIcon
                        viewBox="0 0 16 16"
                        className="size-4 text-brand-500"
                        aria-hidden
                      />
                      <span className="sr-only">({t("current")})</span>
                    </>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </>
  );
}
