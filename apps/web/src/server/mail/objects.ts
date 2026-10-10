/**
 * Oggetti esposti ai template email, con gli stessi nomi di attributo del PHP (getVar/get<Tag>):
 * ticket, utente/proprietario, agente, reparto, help topic, priorità, stato, team, voce del thread,
 * azienda, date formattate. Facciata dei moduli ./formatted-date, ./org-vars, ./entry-var, ./ticket-vars.
 */
export { FormattedDate } from "./formatted-date";
export { answerToString, companyVar, deptVar, formAnswerMap, loadStaffInfo, staffVar } from "./org-vars";
export { entryVar, type EntryInfo } from "./entry-var";
export { buildTicketVars, contactVar, loadUserContact, ticketLink, userPersonsName } from "./ticket-vars";
