/**
 * Stato dell'account di un utente finale (UserAccountStatus, include/class.user.php):
 * nessun account = ospite; bit 0x2 bloccato; bit 0x1 confermato; altrimenti in attesa di conferma.
 */
export type AccountState = "guest" | "locked" | "active" | "pending";

export function accountState(status: number | null | undefined): AccountState {
  if (status === null || status === undefined) return "guest";
  if (status & 0x2) return "locked";
  return status & 0x1 ? "active" : "pending";
}
