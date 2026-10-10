import type { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import type { TimelineEvent } from "@/server/domain/ticket/view";

type EventsT = Awaited<ReturnType<typeof getTranslations<"events">>>;

const b = (chunks: ReactNode) => <strong className="font-medium text-gray-700 dark:text-gray-300">{chunks}</strong>;

/** Frase dell'evento del thread (ThreadEvent di class.thread.php) con i nomi citati già risolti. */
export function describeEvent(te: EventsT, ev: TimelineEvent): ReactNode {
  const somebody = ev.username || "SYSTEM";
  const d = ev.data;
  const { refs } = ev;
  switch (ev.name) {
    case "created":
      return te.rich("created", { somebody, b });
    case "assigned":
      if (d.staff) return te.rich("assignedStaff", { somebody, target: refs.staff, b });
      if (d.team) return te.rich("assignedTeam", { somebody, target: refs.team, b });
      if (d.claim) return te.rich("claimed", { somebody, b });
      return te.rich("assigned", { somebody, b });
    case "released":
      return te.rich("released", { somebody, b });
    case "referred":
      if (d.staff) return te.rich("referred", { somebody, target: refs.staff, b });
      if (d.team) return te.rich("referred", { somebody, target: refs.team, b });
      return te.rich("referred", { somebody, target: refs.dept, b });
    case "closed":
      return d.status ? te.rich("closedStatus", { somebody, status: refs.status, b }) : te.rich("closed", { somebody, b });
    case "reopened":
      return te.rich("reopened", { somebody, b });
    case "overdue":
      return te("overdue");
    case "transferred":
      return te.rich("transferred", { somebody, target: ev.dept_name ?? "", b });
    case "edited":
      if (d.status) return te.rich("statusChanged", { somebody, status: refs.status, b });
      return te.rich("edited", { somebody, b });
    case "collab":
      return te.rich("collab", { somebody, b });
    case "merged":
      return te.rich("merged", { somebody, b });
    case "linked":
      return te.rich("linked", { somebody, b });
    case "resent":
      return te.rich("resent", { somebody, b });
    case "deleted":
      return te.rich("deleted", { somebody, b });
    default:
      return `${ev.name} · ${somebody}`;
  }
}
