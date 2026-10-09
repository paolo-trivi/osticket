import type { DynamicFieldView } from "@/lib/forms/dynamic-field";

/** Proprietà comuni dei renderer dei campi dinamici. */
export interface FieldInputProps {
  field: DynamicFieldView;
  /** valori inviati in precedenza (ripristino dopo un errore) */
  value?: string[];
  errors?: string[];
}
