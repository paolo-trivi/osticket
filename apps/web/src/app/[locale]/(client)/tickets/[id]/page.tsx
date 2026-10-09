import { getTranslations, setRequestLocale } from "next-intl/server";

import PortalThread from "@/components/portal/PortalThread";
import ReplyForm from "@/components/portal/ReplyForm";
import Alert from "@/components/ui/alert/Alert";
import { Link } from "@/i18n/navigation";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { loadClientTicketView } from "@/server/domain/client/tickets";
import { threadUploadRules } from "@/server/domain/file/upload";
import { loadFormDef } from "@/server/domain/forms/load";
import { formatDbDate } from "@/server/format/datetime";

import { requireClient } from "../../guard";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations("portal.ticket");
  const { id } = await params;
  return { title: `${t("title")} ${id}` };
}

const EVENTS = ["created", "closed", "reopened", "edited", "collab", "merged"] as const;

/**
 * Vista del ticket per il cliente (view.inc.php): informazioni di base, campi visibili ai clienti,
 * thread senza note interne e risposta (se aperto o chiuso ma riapribile; non per i figli di un merge).
 */
export default async function ClientTicketPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<{ posted?: string; created?: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const client = await requireClient(locale, `/tickets/${id}`);
  const t = await getTranslations("portal.ticket");
  const cfg = await coreConfig();
  const view = await loadClientTicketView(cfg, client, Number(id) || 0);
  if (!view) {
    return (
      <div className="space-y-4">
        <Alert variant="error" title={t("notFound")} message="" />
        <Link href="/tickets" className="text-brand-600 hover:underline dark:text-brand-400">
          {t("back")}
        </Link>
      </div>
    );
  }
  const tz = client.account?.timezone || cfg.str("default_timezone") || "UTC";
  const tform = await loadFormDef(db(), cfg, { type: "T" }, "client");
  const message = tform?.fields.find((f) => f.type === "thread");
  const rules = threadUploadRules(cfg);
  const eventLabels = Object.fromEntries(EVENTS.map((e) => [e, t(`events.${e}`)]));

  return (
    <div className="space-y-6">
      {client.guest && ["public", "auto"].includes(cfg.str("client_registration")) && (
        <Alert variant="info" title={t("guestTitle")} message={t("guestText")} showLink linkHref="/account" linkText={t("register")} />
      )}
      {sp.created && <Alert variant="success" title={t("created")} message="" />}
      {sp.posted && <Alert variant="success" title={t("posted")} message="" />}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{view.subject}</h1>
          <p className="text-theme-sm text-gray-500 dark:text-gray-400">#{view.number}</p>
        </div>
        {view.canEdit && (
          <Link href={`/tickets/${view.id}/edit`} className="rounded-lg border border-gray-300 px-4 py-2 text-theme-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5">
            {t("edit")}
          </Link>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <dl className="space-y-2 rounded-2xl border border-gray-200 bg-white p-5 text-theme-sm dark:border-gray-800 dark:bg-white/3">
          <h2 className="mb-2 font-medium text-gray-800 dark:text-white/90">{t("basic")}</h2>
          <div className="flex justify-between gap-3"><dt className="text-gray-500 dark:text-gray-400">{t("status")}</dt><dd className="text-gray-800 dark:text-white/90">{view.statusName}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-gray-500 dark:text-gray-400">{t("dept")}</dt><dd className="text-gray-800 dark:text-white/90">{view.dept}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-gray-500 dark:text-gray-400">{t("createDate")}</dt><dd className="text-gray-800 dark:text-white/90">{formatDbDate(view.created, tz, locale, "full")}</dd></div>
        </dl>
        <dl className="space-y-2 rounded-2xl border border-gray-200 bg-white p-5 text-theme-sm dark:border-gray-800 dark:bg-white/3">
          <h2 className="mb-2 font-medium text-gray-800 dark:text-white/90">{t("user")}</h2>
          <div className="flex justify-between gap-3"><dt className="text-gray-500 dark:text-gray-400">{t("name")}</dt><dd className="text-gray-800 dark:text-white/90">{view.ownerName}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-gray-500 dark:text-gray-400">{t("email")}</dt><dd className="text-gray-800 dark:text-white/90">{view.ownerEmail}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-gray-500 dark:text-gray-400">{t("phone")}</dt><dd className="text-gray-800 dark:text-white/90">{view.ownerPhone}</dd></div>
        </dl>
      </div>

      {view.answers.length > 0 && (
        <dl className="space-y-2 rounded-2xl border border-gray-200 bg-white p-5 text-theme-sm dark:border-gray-800 dark:bg-white/3">
          {view.answers.map((a, i) => (
            <div key={i} className="flex justify-between gap-3">
              <dt className="text-gray-500 dark:text-gray-400">{a.label}</dt>
              <dd className="text-gray-800 dark:text-white/90">{a.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <PortalThread
        entries={view.entries}
        events={view.events}
        tz={tz}
        locale={locale}
        hideStaffName={cfg.bool("hide_staff_name")}
        labels={{ posted: t("postedLabel"), staff: t("staff"), edited: t("editedLabel"), events: eventLabels }}
      />

      {view.parentId ? (
        <Alert variant="warning" title={t("merged")} message="" showLink linkHref={`/tickets/${view.parentId}`} linkText={t("parent")} />
      ) : view.closedNotReopenable ? (
        <Alert variant="warning" title={t("closedNotReopenable")} message="" />
      ) : null}
      {view.canReply && <ReplyForm ticketId={view.id} reopen={view.reopenOnReply} attachments={!!message?.config.attachments} maxFileSize={rules?.size ?? 0} />}
    </div>
  );
}
