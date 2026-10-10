import { getTranslations } from "next-intl/server";

import ThreadEntryCard from "@/components/tickets/ThreadEntryCard";
import { TICKET_SOURCE_KEYS } from "@/server/domain/ticket/edit-values";
import type { TimelineItem } from "@/server/domain/ticket/view";
import { formatDbDate } from "@/server/format/datetime";

import { describeEvent, type EventFormat } from "./describe-event";
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
  const ts = await getTranslations("ticketEdit.sources");
  const sources = Object.fromEntries(TICKET_SOURCE_KEYS.map((k) => [k, ts(k)]));
  const fmt: EventFormat = {
    date: (v) => formatDbDate(v, tz, locale, "date"),
    source: (k) => sources[k] ?? k,
  };
  const entryLabels = {
    note: t("internalNote"),
    reply: t("reply"),
    message: t("message"),
    edited: t("editedBy"),
    via: t("via"),
    sources,
  };
  return timeline.map((item) =>
    item.kind === "entry" ? (
      <ThreadEntryCard key={`e${item.id}`} entry={item} tz={tz} locale={locale} labels={entryLabels} iframeWhitelist={iframeWhitelist} />
    ) : (
      <ThreadEventLine key={`v${item.id}`} description={describeEvent(te, item, fmt)} timestamp={item.timestamp} tz={tz} locale={locale} />
    ),
  );
}
