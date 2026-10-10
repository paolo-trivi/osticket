/** Colore del DB (es. ticket_priority.priority_color) utilizzabile in uno style inline: solo #rgb/#rrggbb, altrimenti null. */
export function safeColor(color: string | null | undefined): string | null {
  return color && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color) ? color : null;
}
