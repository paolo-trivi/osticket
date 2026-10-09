/**
 * Avvisi di login falliti (syslog ed email all'amministratore): osTicket scrive l'ora al minuto
 * ("Time: Oct 9, 2026, 6:20 pm UTC"). PHP e TS girano uno dopo l'altro e possono cadere a cavallo
 * di un minuto, quindi l'ora si maschera. Il formato resta verificato: si maschera solo se è identico
 * a quello di osTicket, e il resto del testo si confronta per intero.
 */
const ALERT_TIME_RE = /Time: (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}, \d{1,2}:\d{2} [ap]m UTC/g;

export const maskAlertTime = (s: string): string => s.replace(ALERT_TIME_RE, "Time: <ALERT-TIME>");
