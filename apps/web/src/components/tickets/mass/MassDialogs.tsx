"use client";

import AssignMassDialog from "./dialogs/AssignMassDialog";
import ClaimMassDialog from "./dialogs/ClaimMassDialog";
import DeleteMassDialog from "./dialogs/DeleteMassDialog";
import ExportMassDialog from "./dialogs/ExportMassDialog";
import MergeMassDialog from "./dialogs/MergeMassDialog";
import StatusMassDialog from "./dialogs/StatusMassDialog";
import TransferMassDialog from "./dialogs/TransferMassDialog";
import type { MassData, MassDialogProps, MassKind } from "./types";

/** Dialogo dell'azione di massa scelta. */
export default function MassDialogs({ kind, data, ...common }: MassDialogProps & { kind: MassKind; data: MassData }) {
  if (typeof kind === "object") return <StatusMassDialog {...common} statusId={kind.status} statuses={data.statuses} />;
  switch (kind) {
    case "claim":
      return <ClaimMassDialog {...common} />;
    case "assignAgents":
    case "assignTeams":
      return <AssignMassDialog {...common} what={kind === "assignAgents" ? "agents" : "teams"} />;
    case "transfer":
      return <TransferMassDialog {...common} depts={data.depts} />;
    case "delete":
      return <DeleteMassDialog {...common} />;
    case "merge":
    case "link":
      return <MergeMassDialog {...common} title={kind} data={data} />;
    case "export":
      return <ExportMassDialog data={data} onClose={common.onClose} />;
  }
}
