import type { ReactNode } from "react";

import type { DbDateTime } from "@/server/db/schema.gen";
import { formatDbDate } from "@/server/format/datetime";

interface ThreadEventLineProps {
  description: ReactNode;
  timestamp: DbDateTime;
  tz: string;
  locale: string;
}

/** Evento del thread nella timeline (assegnazione, chiusura, trasferimento…): una riga con pallino e data. */
export default function ThreadEventLine({ description, timestamp, tz, locale }: ThreadEventLineProps) {
  return (
    <div className="flex items-center gap-3 px-2 text-theme-sm text-gray-500 dark:text-gray-400">
      <span className="size-2 rounded-full bg-gray-300 dark:bg-gray-600" />
      <span>{description}</span>
      <span className="text-theme-xs text-gray-400">{formatDbDate(timestamp, tz, locale, "short")}</span>
    </div>
  );
}
