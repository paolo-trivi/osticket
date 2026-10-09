import { getTranslations, setRequestLocale } from "next-intl/server";

import OpenTicketForm from "@/components/portal/OpenTicketForm";
import Alert from "@/components/ui/alert/Alert";
import { redirect } from "@/i18n/navigation";
import { currentClient } from "@/server/auth/client-auth";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { clientDisplayName } from "@/server/domain/client/identity";
import { portalOpenAllowed } from "@/server/domain/client/open";
import { publicTopics } from "@/server/domain/client/ui";
import { threadUploadRules } from "@/server/domain/file/upload";
import { baseForms, topicFormsView } from "@/server/domain/ticket/create-ui";

export async function generateMetadata() {
  const t = await getTranslations("portal.open");
  return { title: t("title") };
}

/**
 * open.php: con "solo clienti registrati" e registrazione disattivata si va alla verifica dello stato;
 * senza accesso al login; un ospite da link deve accedere con un account. Gli ospiti non possono
 * aprire ticket da Next se il captcha è attivo (immagine GD del PHP non replicata).
 */
export default async function OpenTicketPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ topicId?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const cfg = await coreConfig();
  const client = await currentClient();
  if (cfg.bool("clients_only")) {
    if (cfg.str("client_registration") === "disabled") redirect({ href: "/login#access", locale });
    if (!client || client.guest) redirect({ href: "/login?next=/open", locale });
  }
  const t = await getTranslations("portal.open");
  const allowed = portalOpenAllowed(cfg, client);
  const topics = await publicTopics(cfg);
  const requested = Number(sp.topicId) || 0;
  const defaultTopic = topics.some((x) => x.id === requested) ? requested : cfg.int("default_help_topic");
  const [forms, initialTopic] = await Promise.all([baseForms(db(), cfg, "client"), defaultTopic ? topicFormsView(db(), cfg, defaultTopic, "client") : Promise.resolve({ forms: [], disabled: [] })]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{t("title")}</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("subtitle")}</p>
      </div>
      {allowed === true ? (
        <OpenTicketForm
          userForm={client ? null : forms.user}
          ticketForm={forms.ticket}
          topics={topics}
          defaultTopic={defaultTopic}
          initialTopic={initialTopic}
          client={client ? { name: clientDisplayName(client, cfg), email: client.email } : null}
          maxFileSize={threadUploadRules(cfg)?.size ?? 0}
        />
      ) : (
        <Alert variant="warning" title={t(`denied.${allowed}`)} message="" showLink linkHref="/login" linkText={t("signIn")} />
      )}
    </div>
  );
}
