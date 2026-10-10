import "server-only";

/**
 * Campi dei form dinamici (include/class.forms.php + class.dynamic_forms.php): unica definizione dei
 * campi per ticket, task, utenti, organizzazioni e azienda, divisa per responsabilità:
 * - ./field-def: definizione, flag di visibilità, configurazione con i default del tipo, scelte;
 * - ./field-dates: lettura delle date e abbreviazione del fuso come il PHP;
 * - ./field-parse: lettura dell'input (Widget::getValue + FormField::parse);
 * - ./field-validate: validazione (FormField::validateEntry; i validatori sono in ./validator);
 * - ./field-convert: conversioni verso il DB e ritorno, testo per filtri, indice e cdata.
 */

export {
  fieldChoices,
  fieldConfig,
  hasAnswerRow,
  hasData,
  hasFlag,
  isEditableTo,
  isEditableToStaff,
  isIdValue,
  isPresentationOnly,
  isRequiredFor,
  isRequiredForStaff,
  isStorable,
  isVisibleTo,
  isVisibleToStaff,
  plainLabel,
  type CleanValue,
  type DateFormatOptions,
  type FieldDef,
  type FormAudience,
  type FormSource,
} from "./field-def";
export { phpParseDateTime } from "./field-dates";
export { inSource, parseField, parseFieldOrAnswer, parseFieldValue, phpCleanValue } from "./field-parse";
export { FIELD_ERROR_CODES, validateField, type FieldErrorCode } from "./field-validate";
export { answerChangeValue, cleanFromDb, fieldSearchable, fieldSearchKeys, fieldToDatabase, fieldToString, formatPhone } from "./field-convert";
