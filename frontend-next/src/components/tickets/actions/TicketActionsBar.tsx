"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState, type ReactNode } from "react";

import { Dropdown } from "@/components/ui/dropdown/Dropdown";
import { DropdownItem } from "@/components/ui/dropdown/DropdownItem";
import { ChevronDownIcon } from "@/icons";
import { cn } from "@/utils";

import ActionDialogs from "./ActionDialogs";
import type { ActionKind, TicketActionsData } from "./types";

const itemClass =
  "block w-full rounded-lg px-3 py-2 text-start text-theme-sm text-gray-700 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-300";

/** Pulsante con menu a discesa (stile TailAdmin). */
function MenuButton({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="dropdown-toggle inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-theme-sm text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5"
      >
        {label}
        <ChevronDownIcon className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      <Dropdown isOpen={open} onClose={close} className="w-60 p-2">
        {children(close)}
      </Dropdown>
    </div>
  );
}

/** Barra azioni della vista ticket: assegna, trasferisci, stato, altro. */
export default function TicketActionsBar({ data }: { data: TicketActionsData }) {
  const t = useTranslations("ticketActions");
  const [kind, setKind] = useState<ActionKind | null>(null);
  const closeDialog = useCallback(() => setKind(null), []);
  const item = (label: string, k: ActionKind, close: () => void) => (
    <DropdownItem key={typeof k === "object" ? `s${k.status}` : k} baseClassName={itemClass} onClick={() => setKind(k)} onItemClick={close}>
      {label}
    </DropdownItem>
  );
  const { can } = data;
  const hasMore = can.release || can.mark || can.refer;

  return (
    <>
      {can.assign && (
        <MenuButton label={data.isAssigned ? t("reassign") : t("assign")}>
          {(close) => (
            <>
              {can.claim && item(t("claim"), "claim", close)}
              {item(t("toAgent"), "assignAgent", close)}
              {item(t("toTeam"), "assignTeam", close)}
            </>
          )}
        </MenuButton>
      )}
      {can.transfer && (
        <button
          type="button"
          onClick={() => setKind("transfer")}
          className="rounded-lg border border-gray-200 px-3 py-2 text-theme-sm text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5"
        >
          {t("transfer")}
        </button>
      )}
      {can.status && data.statuses.length > 0 && (
        <MenuButton label={t("changeStatus")}>{(close) => data.statuses.map((s) => item(s.name, { status: s.id }, close))}</MenuButton>
      )}
      {hasMore && (
        <MenuButton label={t("more")}>
          {(close) => (
            <>
              {can.release && item(t("releaseMenu"), "release", close)}
              {can.mark && (data.isAnswered ? item(t("markUnanswered"), "markUnanswered", close) : item(t("markAnswered"), "markAnswered", close))}
              {can.refer && item(t("manageReferrals"), "refer", close)}
            </>
          )}
        </MenuButton>
      )}
      {kind !== null && <ActionDialogs kind={kind} data={data} onClose={closeDialog} />}
    </>
  );
}
