/**
 * Codici a una lettera dei tipi di oggetto di osTicket (colonne object_type, type, uid_type…).
 * Codice puro: importabile da server e client. I valori sono verificati contro legacy/include
 * da test/unit/osticket-constants.test.ts.
 */

/** ObjectModel::OBJECT_TYPE_* (class.model.php): thread.object_type, thread_referral.object_type, form_entry.object_type… */
export const ObjectType = {
  TICKET: "T",
  THREAD: "H",
  USER: "U",
  ORG: "O",
  FAQ: "K",
  FILE: "F",
  TASK: "A",
  TEAM: "E",
  DEPT: "D",
  STAFF: "S",
  /** thread di un ticket figlio di un merge a thread combinati (TicketThread "child") */
  CHILD_TICKET: "C",
} as const;

/** thread_entry.type: MessageThreadEntry / ResponseThreadEntry / NoteThreadEntry::ENTRY_TYPE (class.thread.php) */
export const ThreadEntryType = { MESSAGE: "M", RESPONSE: "R", NOTE: "N" } as const;

/**
 * form.type (DynamicForm::$types, TaskForm, OrganizationForm, Company, DynamicList) e
 * form_entry.object_type (stessi codici, senza G/L). Le liste usano "L" seguito dall'id della lista.
 */
export const FormType = {
  TICKET: "T",
  USER: "U",
  ORG: "O",
  TASK: "A",
  /** informazioni dell'azienda (class.company.php) */
  COMPANY: "C",
  /** form generico, aggiungibile a un ticket (class.dynamic_forms.php) */
  GENERIC: "G",
  /** proprietà degli elementi di una lista: "L<id lista>" (class.list.php) */
  LIST_PREFIX: "L",
} as const;

/** attachment.type: tipo dell'oggetto a cui è legato l'allegato (join del modello Attachment e GenericAttachments) */
export const AttachmentType = {
  /** voce di thread (class.attachment.php) */
  THREAD_ENTRY: "H",
  /** risposta predefinita (class.canned.php) */
  CANNED: "C",
  /** FAQ (class.faq.php) */
  FAQ: "F",
  /** pagina del sito (class.page.php) */
  PAGE: "P",
  /** bozza (class.draft.php) */
  DRAFT: "D",
  /** modello di email (class.template.php) */
  EMAIL_TEMPLATE: "T",
  /** campo file di un form (FileUploadField, class.forms.php) */
  FORM_FILE: "E",
  /** immagini di un campo informativo (FreeTextField, class.forms.php) */
  FORM_INFO: "I",
} as const;
