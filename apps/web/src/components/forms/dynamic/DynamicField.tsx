"use client";

import { useTranslations } from "next-intl";

import BoolFieldInput from "./BoolFieldInput";
import ChoiceFieldInput from "./ChoiceFieldInput";
import DatetimeFieldInput from "./DatetimeFieldInput";
import FieldShell from "./FieldShell";
import InfoField from "./InfoField";
import MemoFieldInput from "./MemoFieldInput";
import PhoneFieldInput from "./PhoneFieldInput";
import TextFieldInput from "./TextFieldInput";
import type { FieldInputProps } from "./types";

/** Sceglie il renderer in base al tipo di campo di osTicket. */
export default function DynamicField(props: FieldInputProps) {
  const t = useTranslations("dynamicForms");
  const { field } = props;
  switch (field.kind) {
    case "text":
    case "timezone":
      return <TextFieldInput {...props} />;
    case "memo":
      return <MemoFieldInput {...props} />;
    case "choices":
    case "list":
    case "priority":
    case "department":
      return <ChoiceFieldInput {...props} />;
    case "bool":
      return <BoolFieldInput {...props} />;
    case "datetime":
      return <DatetimeFieldInput {...props} />;
    case "phone":
      return <PhoneFieldInput {...props} />;
    case "info":
    case "break":
      return <InfoField field={field} />;
    default:
      return (
        <FieldShell label={field.label} hint={t("unsupported")}>
          <span />
        </FieldShell>
      );
  }
}
