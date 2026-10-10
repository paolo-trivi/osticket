import type { getTranslations } from "next-intl/server";
import { Fragment, type ReactNode } from "react";

import { Link } from "@/i18n/navigation";
import type { ThreadEventChange, TimelineEvent } from "@/server/domain/ticket/view";

type EventsT = Awaited<ReturnType<typeof getTranslations<"events">>>;

/** Formattazione fuori dai messaggi: date nel fuso dell'agente e origini tradotte come in lista. */
export interface EventFormat {
  date: (dbValue: string) => string;
  source: (key: string) => string;
}

const b = (chunks: ReactNode) => <strong className="font-medium text-gray-700 dark:text-gray-300">{chunks}</strong>;

/** Ticket citato da MergedEvent / LinkedEvent / UnlinkEvent (`data.id`, `data.ticket`), con il link come nel PHP. */
function ticketRef(ev: TimelineEvent): ReactNode {
  const label = typeof ev.data.ticket === "string" ? ev.data.ticket : "";
  const id = Number(ev.data.id);
  if (!label) return null;
  return id > 0 ? (
    <Link href={`/agent/tickets/${id}`} className="text-brand-600 hover:underline dark:text-brand-400">
      {label}
    </Link>
  ) : (
    label
  );
}

/** Modifiche di EditEvent: "<campo> cambiato da X a Y" / "impostato a" / "rimosso", separate da virgole. */
function changesText(te: EventsT, changes: ThreadEventChange[], ev: TimelineEvent, fmt: EventFormat): ReactNode {
  const show = (c: ThreadEventChange, v: string) => {
    if (!v) return v;
    if (c.column === "duedate") return fmt.date(v);
    if (c.column === "source") return fmt.source(v);
    if (c.column === "sla_id") {
      // SLA::getSLAName: nome con ore di tolleranza e stato, come SLA::getSLAs()
      const s = ev.refs.slas?.[v];
      return s
        ? te("slaName", {
            name: s.name,
            hours: s.hours,
            active: s.active ? "yes" : "no",
          })
        : v;
    }
    return v;
  };
  return changes.map((c, i) => {
    const field = c.column ? te(`fields.${c.column}`) : c.label;
    const o = show(c, c.old);
    const n = show(c, c.new);
    return (
      <Fragment key={i}>
        {i > 0 && ", "}
        {o && n ? te.rich("changeFromTo", { field, old: o, new: n, b }) : n ? te.rich("changeSet", { field, new: n, b }) : te.rich("changeUnset", { field, b })}
      </Fragment>
    );
  });
}

/** Frase dell'evento del thread (ThreadEvent di class.thread.php) con i nomi citati già risolti. */
export function describeEvent(te: EventsT, ev: TimelineEvent, fmt: EventFormat = { date: (v) => v, source: (k) => k }): ReactNode {
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
      // EditEvent: stesso ordine di casi del PHP
      if (d.filter) {
        const type = String(d.type ?? "");
        const what = te.has(`filterTypes.${type}`) ? te(`filterTypes.${type}`) : type;
        return d.value
          ? te.rich("filterSet", {
              filter: String(d.filter),
              type: what,
              value: String(d.value),
              b,
            })
          : te.rich("filterSetEmpty", {
              filter: String(d.filter),
              type: what,
              b,
            });
      }
      if (d.owner)
        return te.rich("ownerChanged", {
          somebody,
          owner: refs.owner ?? "",
          b,
        });
      if (d.status) return te.rich("statusChanged", { somebody, status: refs.status, b });
      if (refs.changes?.length) {
        const changes = refs.changes;
        return te.rich("editedChanges", {
          somebody,
          b,
          changes: () => changesText(te, changes, ev, fmt),
        });
      }
      return te.rich("edited", { somebody, b });
    case "collab":
      if (d.org) return te.rich("collabOrg", { org: refs.org ?? "", b });
      if (refs.collabRemoved?.length)
        return te.rich("collabRemoved", {
          somebody,
          names: refs.collabRemoved.join(", "),
          b,
        });
      if (refs.collabAdded?.length) {
        const names = refs.collabAdded.map((c) => (c.src ? te("collabVia", { name: c.name, src: c.src }) : c.name)).join(", ");
        return te.rich("collabAdded", { somebody, names, b });
      }
      return te.rich("collab", { somebody, b });
    case "merged":
      return d.ticket ? te.rich("mergedWith", { somebody, b, ticket: () => b(ticketRef(ev)) }) : te.rich("merged", { somebody, b });
    case "linked":
      return d.ticket ? te.rich("linkedWith", { somebody, b, ticket: () => b(ticketRef(ev)) }) : te.rich("linked", { somebody, b });
    case "unlinked":
      return d.ticket
        ? te.rich("unlinkedFrom", {
            somebody,
            b,
            ticket: () => b(ticketRef(ev)),
          })
        : te.rich("unlinked", { somebody, b });
    case "resent":
      return te.rich("resent", { somebody, b });
    case "deleted":
      return te.rich("deleted", { somebody, b });
    default:
      return `${ev.name} · ${somebody}`;
  }
}
