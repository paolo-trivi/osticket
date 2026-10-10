"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import type { MassActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/actions-mass";
import ActionNotice from "@/components/common/ActionNotice";
import { useRouter } from "@/i18n/navigation";
import { checkedIds } from "@/lib/checked-ids";

import MassActionMenu from "./MassActionMenu";
import MassDialogs from "./MassDialogs";
import type { MassData, MassKind } from "./types";

/**
 * Barra delle azioni di massa della lista (include/staff/templates/tickets-actions.tmpl.php): cambio
 * stato, presa in carico/assegnazione, merge, link, trasferimento, eliminazione; più l'export CSV
 * della coda (queue-tickets.tmpl.php → ajax.php/tickets/export/<id>).
 * Contenitore: tiene selezione, azione aperta ed esito; menu e dialoghi sono presentazionali.
 */
export default function TicketMassActions({ data }: { data: MassData }) {
  const t = useTranslations("ticketEdit.mass");
  const router = useRouter();
  const [kind, setKind] = useState<MassKind | null>(null);
  const [ids, setIds] = useState<number[]>([]);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const close = useCallback(() => setKind(null), []);

  const open = (k: MassKind) => {
    // la lista ha due viste (schede su mobile, tabella da md in su): stessi id, senza duplicati
    const sel = checkedIds("input[data-mass-tid]");
    if (k !== "export" && !sel.length) {
      setNotice({ ok: false, text: t("selectFirst") });
      return;
    }
    setIds(sel);
    setKind(k);
  };
  const onSuccess = useCallback(
    (s: MassActionState) => {
      setKind(null);
      setNotice({ ok: true, text: s.count === s.total ? t("doneAll", { count: s.count ?? 0 }) : t("donePartial", { count: s.count ?? 0, total: s.total ?? 0 }) });
      router.refresh();
    },
    [router, t],
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <MassActionMenu data={data} onOpen={open} />
      {notice && (
        <ActionNotice tone={notice.ok ? "success" : "warning"} closeLabel={t("close")} onClose={() => setNotice(null)}>
          {notice.text}
        </ActionNotice>
      )}
      {kind !== null && <MassDialogs kind={kind} ids={ids} data={data} onClose={close} onSuccess={onSuccess} />}
    </div>
  );
}
