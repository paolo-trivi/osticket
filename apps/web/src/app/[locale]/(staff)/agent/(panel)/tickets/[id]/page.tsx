import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import TicketAnswersCard from "@/components/tickets/view/TicketAnswersCard";
import TicketAssignmentCard from "@/components/tickets/view/TicketAssignmentCard";
import TicketCollaboratorsCard from "@/components/tickets/view/TicketCollaboratorsCard";
import TicketComposerSection from "@/components/tickets/view/TicketComposerSection";
import TicketDetailsCard from "@/components/tickets/view/TicketDetailsCard";
import TicketHeader from "@/components/tickets/view/TicketHeader";
import TicketTasksCard from "@/components/tickets/view/TicketTasksCard";
import TicketThread from "@/components/tickets/view/TicketThread";
import TicketUserCard from "@/components/tickets/view/TicketUserCard";
import { loadTicketView, ticketViewNumber } from "@/server/domain/ticket/view";

import { requireAgent } from "../../../guard";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const number = await ticketViewNumber(Number(id));
  return { title: number ? `#${number}` : "Ticket" };
}

export default async function TicketViewPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const view = await loadTicketView(agent, Number(id));
  // Come scp/tickets.php: ticket inesistente o non accessibile → stesso messaggio
  if (!view) notFound();
  const { ticket, tz } = view;

  return (
    <div className="space-y-6">
      <TicketHeader ticket={ticket} agent={agent} locale={locale} taskCount={view.taskCount} legacyUrl={view.legacyUrl} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <TicketThread timeline={view.timeline} tz={tz} locale={locale} iframeWhitelist={view.iframeWhitelist} />
          <TicketComposerSection composer={view.composer} />
        </div>

        <aside className="space-y-6">
          <TicketDetailsCard ticket={ticket} tz={tz} locale={locale} />
          <TicketUserCard ticket={ticket} />
          <TicketAssignmentCard assignee={view.assignee} teamName={ticket.team_name} roleName={view.role.name} />
          {view.tasks.length > 0 && <TicketTasksCard tasks={view.tasks} tz={tz} locale={locale} />}
          {view.collaborators.length > 0 && <TicketCollaboratorsCard collaborators={view.collaborators} />}
          {view.answers.length > 0 && <TicketAnswersCard answers={view.answers} />}
        </aside>
      </div>
    </div>
  );
}
