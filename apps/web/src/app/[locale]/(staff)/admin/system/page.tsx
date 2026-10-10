import { Suspense, type ReactNode } from "react";

import { createTranslator } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";

import Callout from "@/components/common/Callout";
import ComponentCard from "@/components/common/ComponentCard";
import { PageHeader } from "@/components/common/DataTable";
import InfoRow from "@/components/common/InfoRow";
import Badge from "@/components/ui/badge/Badge";
import doctorEn from "@/messages/doctor/en.json";
import doctorIt from "@/messages/doctor/it.json";
import { db } from "@/server/db";
import { systemInfo } from "@/server/domain/adminsys/system-info";
import { runDoctor } from "@/server/system/doctor";
import { sortChecks } from "@/server/system/doctor/format";
import { errorText, isWritable, type DoctorLevel } from "@/server/system/doctor/types";

import { requireAdmin } from "../guard";
import { adminMetadata } from "../metadata";

export const generateMetadata = adminMetadata("system");

/** Informazioni di sistema (include/staff/system.inc.php): PHP sostituito da Node/Next. */
export default async function SystemPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("asys.system");
  const info = await systemInfo(db());
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <ComponentCard title={t("server")}>
          <dl>
          <InfoRow label={t("osticketVersion")} value={info.osticketVersion ?? "—"} />
          <InfoRow label={t("nextVersion")} value={info.nextVersion ?? "—"} />
          <InfoRow label={t("nodeVersion")} value={info.nodeVersion} />
          <InfoRow label={t("dbVersion")} value={info.dbVersion} />
          <InfoRow label={t("plugins")} value={String(info.plugins)} />
          </dl>
        </ComponentCard>
        <ComponentCard title={t("database")}>
          <dl>
          <InfoRow label={t("schema")} value={`${info.dbName} (${info.dbHost})`} />
          <InfoRow label={t("prefix")} value={info.tablePrefix} />
          <InfoRow label={t("signature")} value={info.schemaSignature || "—"} />
          <InfoRow label={t("space")} value={`${info.spaceUsedMiB.toFixed(2)} MiB`} />
          <InfoRow label={t("attachments")} value={`${info.attachmentsMiB.toFixed(2)} MiB`} />
          <InfoRow
            label={t("timezone")}
            value={info.configuredDbTimezone && info.configuredDbTimezone !== info.dbTimezone ? `${info.dbTimezone} (${t("interpreted", { tz: info.configuredDbTimezone })})` : info.dbTimezone}
          />
          </dl>
        </ComponentCard>
        <ComponentCard title={t("languages")}>
          <p className="text-sm text-gray-700 dark:text-gray-300">{info.languages.length ? info.languages.join(", ") : "en_US"}</p>
        </ComponentCard>
        <ComponentCard title={t("notesTitle")}>
          <p className="text-sm text-gray-600 dark:text-gray-400">{t("notes")}</p>
        </ComponentCard>
      </div>
      <Suspense
        fallback={
          <DoctorCard locale={locale}>
            <p className="text-sm text-gray-500 dark:text-gray-400">{doctorT(locale)("loading")}</p>
          </DoctorCard>
        }
      >
        <DoctorSection locale={locale} />
      </Suspense>
    </div>
  );
}

/**
 * Sezione "Collegamento a osTicket": risultati del doctor (src/server/system/doctor) raggruppati per
 * livello. Il doctor verifica anche la connessione SMTP (timeout di pochi secondi): la sezione arriva
 * in streaming per non rallentare il resto della pagina. I testi dei controlli sono in italiano e non
 * contengono segreti. Messaggi dell'interfaccia in src/messages/doctor/<locale>.json, caricati qui.
 */
const LEVELS: readonly DoctorLevel[] = ["block", "warn", "info", "ok"];
const LEVEL_COLOR = {
  block: "error",
  warn: "warning",
  info: "info",
  ok: "success",
} as const;

function doctorT(locale: string) {
  return createTranslator({
    locale,
    messages: locale === "en" ? doctorEn : doctorIt,
    namespace: "doctor",
  });
}

function DoctorCard({ locale, children }: { locale: string; children: ReactNode }) {
  const t = doctorT(locale);
  return (
    <ComponentCard title={t("title")} desc={t("desc")}>
      {children}
    </ComponentCard>
  );
}

async function DoctorSection({ locale }: { locale: string }) {
  const t = doctorT(locale);
  let report;
  try {
    report = await runDoctor();
  } catch (ex) {
    return (
      <DoctorCard locale={locale}>
        <Callout tone="error" role="alert">
          {t("error", { message: errorText(ex) })}
        </Callout>
      </DoctorCard>
    );
  }
  const checks = sortChecks(report.checks);
  return (
    <DoctorCard locale={locale}>
      <Callout tone={isWritable(report) ? "success" : "error"} role="status">
        <p className="font-medium">{isWritable(report) ? t("writable") : t("blocked", { count: report.summary.block })}</p>
        <p className="mt-1">{t("summary", report.summary)}</p>
      </Callout>
      {LEVELS.map((level) => {
        const group = checks.filter((c) => c.level === level);
        if (!group.length) return null;
        return (
          <section key={level} aria-labelledby={`doctor-${level}`}>
            <h4 id={`doctor-${level}`} className="mb-3 text-sm font-medium text-gray-800 dark:text-white/90">
              <Badge size="sm" color={LEVEL_COLOR[level]}>
                {t(`levels.${level}`)}
              </Badge>{" "}
              <span className="text-gray-500 dark:text-gray-400">({group.length})</span>
            </h4>
            <ul className="divide-y divide-gray-100 rounded-lg border border-gray-100 dark:divide-gray-800 dark:border-gray-800">
              {group.map((c) => (
                <li key={c.id} className="p-4 text-sm">
                  <p className="font-medium text-gray-800 dark:text-white/90">{c.title}</p>
                  <p className="mt-1 text-gray-600 dark:text-gray-400">{c.detail}</p>
                  {c.hint && (
                    <div className="mt-2 text-gray-600 dark:text-gray-400">
                      <span className="font-medium text-gray-700 dark:text-gray-300">{t("hint")}: </span>
                      <span className="break-words whitespace-pre-wrap">{c.hint}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <div>
        <h4 className="mb-2 text-sm font-medium text-gray-800 dark:text-white/90">{t("legendTitle")}</h4>
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          {LEVELS.map((level) => (
            <div key={level} className="flex items-start gap-2">
              <dt className="shrink-0">
                <Badge size="sm" color={LEVEL_COLOR[level]}>
                  {t(`levels.${level}`)}
                </Badge>
              </dt>
              <dd className="text-gray-600 dark:text-gray-400">{t(`legend.${level}`)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{t("contentNote")}</p>
      </div>
    </DoctorCard>
  );
}
