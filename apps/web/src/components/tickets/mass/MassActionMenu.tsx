"use client";

import { useTranslations } from "next-intl";

import MenuButton from "@/components/common/MenuButton";
import { menuButtonClass, menuItemClass } from "@/components/common/menu-classes";
import { DropdownItem } from "@/components/ui/dropdown/DropdownItem";
import { useWriteMode } from "@/context/WriteModeContext";
import { cn } from "@/utils";

import type { MassData, MassKind } from "./types";

interface MassActionMenuProps {
  data: MassData;
  /** apre l'azione scelta (il contenitore verifica la selezione) */
  onOpen: (kind: MassKind) => void;
}

/** Pulsanti e menu delle azioni di massa ammesse dai permessi dell'agente (in sola lettura solo l'export). */
export default function MassActionMenu({ data, onOpen }: MassActionMenuProps) {
  const t = useTranslations("ticketEdit.mass");
  const writable = useWriteMode().canWrite("operational");
  const can = writable
    ? data.can
    : {
        ...data.can,
        status: false,
        assign: false,
        merge: false,
        link: false,
        transfer: false,
        delete: false,
      };
  const item = (label: string, k: MassKind, c: () => void) => (
    <DropdownItem key={typeof k === "object" ? `s${k.status}` : k} baseClassName={menuItemClass} onClick={() => onOpen(k)} onItemClick={c}>
      {label}
    </DropdownItem>
  );
  const button = (k: Exclude<MassKind, object>, label: string, className = menuButtonClass) => (
    <button type="button" className={className} onClick={() => onOpen(k)}>
      {label}
    </button>
  );

  return (
    <>
      {can.status && data.statuses.length > 0 && <MenuButton label={t("status")}>{(c) => data.statuses.map((s) => item(s.name, { status: s.id }, c))}</MenuButton>}
      {can.assign && (
        <MenuButton label={t("assign")}>
          {(c) => (
            <>
              {item(t("claim"), "claim", c)}
              {item(t("toAgent"), "assignAgents", c)}
              {item(t("toTeam"), "assignTeams", c)}
            </>
          )}
        </MenuButton>
      )}
      {can.merge && button("merge", t("merge"))}
      {can.link && button("link", t("link"))}
      {can.transfer && button("transfer", t("transfer"))}
      {can.delete && button("delete", t("delete"), cn(menuButtonClass, "text-error-600 dark:text-error-400"))}
      {can.export && button("export", t("export"))}
    </>
  );
}
