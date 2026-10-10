import { UserAccountStatus } from "./osticket/flags";

/**
 * Stato dell'account di un utente finale (UserAccountStatus, include/class.user.php):
 * nessun account = ospite; bloccato (LOCKED); confermato (CONFIRMED); altrimenti in attesa di conferma.
 */
export type AccountState = "guest" | "locked" | "active" | "pending";

export function accountState(status: number | null | undefined): AccountState {
  if (status === null || status === undefined) return "guest";
  if (status & UserAccountStatus.LOCKED) return "locked";
  return status & UserAccountStatus.CONFIRMED ? "active" : "pending";
}
