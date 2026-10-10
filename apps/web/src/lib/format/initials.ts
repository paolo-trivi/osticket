/** Iniziali di un nome per gli avatar: prima lettera del primo e dell'ultimo nome ("Laura Bianchi" → "LB"), o le prime due lettere di un nome solo. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? (parts[0][0] ?? "") + (parts[parts.length - 1][0] ?? "") : (parts[0] ?? "").slice(0, 2);
  return s.toUpperCase();
}
