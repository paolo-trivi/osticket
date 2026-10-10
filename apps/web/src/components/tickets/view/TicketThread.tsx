import { getTranslations } from "next-intl/server";

import ThreadEntryCard from "@/components/tickets/ThreadEntryCard";
import type { TimelineItem } from "@/server/domain/ticket/view";

import { describeEvent } from "./describe-event";
import ThreadEventLine from "./ThreadEventLine";

interface TicketThreadProps {
  timeline: TimelineItem[];
  tz: string;
  locale: string;
  iframeWhitelist: string[];
}

/** Thread del ticket: messaggi, risposte e note alternati agli eventi, nell'ordine già calcolato dal loader. */
export default async function TicketThread({ timeline, tz, locale, iframeWhitelist }: TicketThreadProps) {
  const t = await getTranslations("ticket");
  const te = await getTranslations("events");
  const entryLabels = { note: t("internalNote"), reply: t("reply"), message: t("message"), edited: t("editedBy"), via: t("via") };
  return timeline.map((item) =>
    item.kind === "entry" ? (
      <ThreadEntryCard key={`e${item.id}`} entry={item} tz={tz} locale={locale} labels={entryLabels} iframeWhitelist={iframeWhitelist} />
    ) : (
      <ThreadEventLine key={`v${item.id}`} description={describeEvent(te, item)} timestamp={item.timestamp} tz={tz} locale={locale} />
    ),
  );
}
