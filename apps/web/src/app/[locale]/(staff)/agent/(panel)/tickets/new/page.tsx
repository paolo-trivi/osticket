import { getTranslations, setRequestLocale } from "next-intl/server";

import { Forbidden, PageHeader } from "@/components/common/DataTable";
import NewTicketForm from "@/components/tickets/create/NewTicketForm";
import type { NewTicketOptions } from "@/components/tickets/create/types";
import { Link } from "@/i18n/navigation";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { threadUploadRules } from "@/server/domain/file/upload";
import { TicketPerm } from "@/server/domain/staff/staff";
import { baseForms, openTicketOptions } from "@/server/domain/ticket/create-ui";

import { requireAgent } from "../../../guard";

export async function generateMetadata() {
  const t = await getTranslations("createTicket");
  return { title: t("title") };
}

/** Apertura di un nuovo ticket da agente (scp/tickets.php?a=open); permesso ticket.create. */
export default async function NewTicketPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
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
  const [opts, forms] = await Promise.all([openTicketOptions(db(), cfg, agent), baseForms(db(), cfg, "staff")]);
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
      <NewTicketForm options={options} uploadUrl="/api/agent/upload" />
    </div>
  );
}
