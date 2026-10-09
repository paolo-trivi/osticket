import { useTranslations } from "next-intl";

import Badge from "@/components/ui/badge/Badge";
import { accountState, type AccountState } from "@/lib/account-status";

const COLOR: Record<AccountState, "light" | "error" | "success" | "warning"> = {
  guest: "light",
  locked: "error",
  active: "success",
  pending: "warning",
};
const LABEL: Record<AccountState, "accountGuest" | "accountLocked" | "accountActive" | "accountPending"> = {
  guest: "accountGuest",
  locked: "accountLocked",
  active: "accountActive",
  pending: "accountPending",
};

/** Badge dello stato dell'account di un utente (ospite, attivo, in attesa, bloccato). */
export default function AccountStatusBadge({ status }: { status: number | null | undefined }) {
  const t = useTranslations("directory");
  const state = accountState(status);
  return (
    <Badge size="sm" color={COLOR[state]}>
      {t(LABEL[state])}
    </Badge>
  );
}
