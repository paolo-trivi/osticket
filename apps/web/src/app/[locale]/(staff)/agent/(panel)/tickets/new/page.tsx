import { getTranslations, setRequestLocale } from "next-intl/server";

import { Forbidden, PageHeader } from "@/components/common/DataTable";
import { ReadOnlyNotice, WriteGate } from "@/components/common/WriteGate";
import NewTicketForm from "@/components/tickets/create/NewTicketForm";
import type { NewTicketOptions } from "@/components/tickets/create/types";
import { Link } from "@/i18n/navigation";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { threadUploadRules } from "@/server/domain/file/upload";
import { TicketPerm } from "@/server/domain/staff/staff";
import { parseId } from "@/lib/route-id";
import { baseForms, openTicketOptions, usersByIds } from "@/server/domain/ticket/create-ui";

import { requireAgent } from "../../../guard";

export async function generateMetadata() {
  const t = await getTranslations("createTicket");
  return { title: t("title") };
}

/** Apertura di un nuovo ticket da agente (scp/tickets.php?a=open); permesso ticket.create. */
export default async function NewTicketPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ uid?: string }> }) {
  const { locale } = await params;
  const { uid } = await searchParams;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const t = await getTranslations("createTicket");
  if (!agent.hasPermInAnyRole(TicketPerm.CREATE)) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("title")} />
        <Forbidden message={t("forbidden")} />
      </div>
    );
  }

  const cfg = await coreConfig();
  // ?uid=<id>: utente preselezionato come tickets.php?a=open&uid= (User::lookup). Nessun permesso oltre a
  // ticket.create, come il PHP e come la ricerca utenti dello stesso form; id non validi o inesistenti ignorati
  const userId = parseId(uid);
  const [opts, forms, picked] = await Promise.all([openTicketOptions(db(), cfg, agent), baseForms(db(), cfg, "staff"), userId ? usersByIds(db(), [userId]) : Promise.resolve([])]);
  const rules = threadUploadRules(cfg);
  const options: NewTicketOptions = { ...opts, ticketForm: forms.ticket, userForm: forms.user, maxFileSize: rules?.size ?? 0 };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Link href="/agent/tickets" className="text-sm text-brand-600 hover:underline dark:text-brand-400">
            {t("back")}
          </Link>
        }
      />
      {/* sola lettura: avviso al posto del form */}
      <WriteGate fallback={<ReadOnlyNotice />}>
        <NewTicketForm options={options} uploadUrl="/api/agent/upload" defaultUser={picked[0] ?? null} />
      </WriteGate>
    </div>
  );
}
