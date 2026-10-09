import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import { ChatIcon } from "@/icons";
import type { QueueColumnDef } from "@/server/domain/queue/engine";
import type { TicketRow } from "@/server/domain/ticket/rows";
import { formatDbDate, isoOf, type DateStyle } from "@/server/format/datetime";
import { cn } from "@/utils";

/**
 * Cella di una colonna di coda: valore del percorso `primary` (o `secondary` se vuoto),
 * filtro di formato (link:ticket, date:full, date:human…) e annotazioni (QueueColumnAnnotation).
 */
interface Props {
  column: QueueColumnDef;
  row: TicketRow;
  tz: string;
  locale: string;
  assigneeName: string;
  staffName: string;
}

function rawValue(path: string, row: TicketRow, names: { assignee: string; staff: string }): string | null {
  switch (path) {
    case "number":
      return row.number;
    case "created":
      return row.created;
    case "lastupdate":
      return row.lastupdate;
    case "closed":
      return row.closed;
    case "duedate":
      return row.duedate;
    case "est_duedate":
      return row.est_duedate;
    case "reopened":
      return null;
    case "cdata__subject":
      return row.subject;
    case "cdata__priority":
      return row.priority;
    case "user__name":
      return row.user_name;
    case "user__emails__address":
      return row.user_email;
    case "user__org__name":
      return row.org_name;
    case "status__id":
    case "status__name":
      return row.status_name;
    case "assignee":
      return names.assignee;
    case "staff_id":
      return names.staff;
    case "team_id":
      return row.team_name;
    case "dept_id":
      return row.dept_name;
    case "topic_id":
      return row.topic_name;
    case "sla_id":
      return row.sla_name;
    case "source":
      return row.source;
    case "thread__lastmessage":
      return row.lastmessage;
    case "thread__lastresponse":
      return row.lastresponse;
    case "thread_count":
      return String(row.thread_count);
    case "attachment_count":
      return String(row.attachment_count);
    case "collaborator_count":
      return String(row.collaborator_count);
    case "task_count":
      return String(row.task_count);
    default:
      return null;
  }
}

/** Valuta le condizioni di stile della colonna (es. grassetto se non risposto). */
function conditionStyle(column: QueueColumnDef, row: TicketRow): React.CSSProperties {
  const style: Record<string, string> = {};
  for (const cond of column.conditions ?? []) {
    const [path, method] = cond.crit;
    let match = false;
    if (path === "isanswered") match = method === "nset" ? !row.isanswered : row.isanswered;
    else if (path === "isoverdue") match = method === "nset" ? !row.isoverdue : row.isoverdue;
    if (match) Object.assign(style, cond.prop);
  }
  return Object.fromEntries(Object.entries(style).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v]));
}

const SOURCES = ["Email", "Web", "Phone", "API", "Other"] as const;

/** Colore della priorità dal DB (ticket_priority.priority_color), solo se è un esadecimale valido. */
function safeColor(color: string | null): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : "#98a2b3";
}

export default function TicketCell({ column, row, tz, locale, assigneeName, staffName }: Props) {
  const tSource = useTranslations("ticketEdit.sources");
  const sourceLabel = (SOURCES as readonly string[]).includes(row.source) ? tSource(row.source as (typeof SOURCES)[number]) : row.source;
  const names = { assignee: assigneeName, staff: staffName };
  let value = rawValue(column.primary, row, names);
  if (!value && column.secondary) value = rawValue(column.secondary, row, names);

  const filter = column.filter ?? "";
  let content: React.ReactNode = value ?? "";
  if (filter.startsWith("date:") && value) {
    const style = (filter.slice(5) === "human" ? "human" : filter.slice(5) === "short" ? "short" : "full") as DateStyle;
    content = (
      <time dateTime={isoOf(value)} title={formatDbDate(value, tz, locale, "full")}>
        {formatDbDate(value, tz, locale, style)}
      </time>
    );
  }
  if (column.primary === "cdata__priority" && row.priority) {
    const color = safeColor(row.priority_color);
    content = (
      // i colori di osTicket sono tinte pastello pensate come sfondo: testo scuro in entrambi i temi
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-theme-xs font-medium text-gray-800 ring-1 ring-black/10 ring-inset"
        style={{ backgroundColor: color }}
      >
        {row.priority}
      </span>
    );
  }
  if (filter.startsWith("link:ticket")) {
    content = (
      <Link href={`/agent/tickets/${row.ticket_id}`} className="text-brand-600 hover:underline dark:text-brand-400">
        {content}
      </Link>
    );
  }

  const ann = column.annotations ?? [];
  const before: React.ReactNode[] = [];
  const after: React.ReactNode[] = [];
  for (const a of ann) {
    const target = a.p === "<" || a.p === "b" ? before : after;
    switch (a.c) {
      case "TicketThreadCount":
        if (row.thread_count > 1)
          target.push(
            <span key={a.c} className="inline-flex items-center gap-0.5 text-theme-xs text-gray-500 dark:text-gray-400">
              <ChatIcon className="size-3.5" aria-hidden />
              {row.thread_count}
            </span>,
          );
        break;
      case "ThreadAttachmentCount":
        if (row.attachment_count) target.push(<span key={a.c} title={String(row.attachment_count)}>📎</span>);
        break;
      case "ThreadCollaboratorCount":
        if (row.collaborator_count)
          target.push(
            <span key={a.c} className="text-theme-xs text-gray-500">
              +{row.collaborator_count}
            </span>,
          );
        break;
      case "OverdueFlagDecoration":
        if (row.isoverdue) target.push(<span key={a.c} className="text-error-500" title="Overdue">⚑</span>);
        break;
      case "LockDecoration":
        if (row.locked_by_other) target.push(<span key={a.c} title="Locked">🔒</span>);
        break;
      case "TicketSourceDecoration":
        target.push(
          <span key={a.c} className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-theme-xs text-gray-600 dark:bg-white/5 dark:text-gray-400">
            {sourceLabel}
          </span>,
        );
        break;
      case "MergedFlagDecoration":
        if (row.flags & 0x3) target.push(<span key={a.c} title="Merged">⇉</span>);
        break;
      case "LinkedFlagDecoration":
        if (row.flags & 0x8) target.push(<span key={a.c} title="Linked">🔗</span>);
        break;
    }
  }

  return (
    <span
      className={cn("inline-flex max-w-full items-center gap-1.5", column.truncate === "ellipsis" && "truncate")}
      style={conditionStyle(column, row)}
    >
      {before}
      <span className={cn(column.truncate === "ellipsis" && "truncate")}>{content}</span>
      {after}
    </span>
  );
}
