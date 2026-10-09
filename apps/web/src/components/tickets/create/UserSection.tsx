"use client";

import { useState } from "react";

import { useTranslations } from "next-intl";

import ComponentCard from "@/components/common/ComponentCard";
import DynamicForm from "@/components/forms/dynamic/DynamicForm";
import FieldShell from "@/components/forms/dynamic/FieldShell";
import { selectCls } from "@/components/forms/dynamic/styles";
import type { DynamicFormView } from "@/lib/forms/dynamic-field";
import { cn } from "@/utils";

import { first, type SubmittedValues } from "./types";
import UserPicker, { type PickedUser } from "./UserPicker";

interface Props {
  userForm: DynamicFormView | null;
  search: (q: string) => Promise<PickedUser[]>;
  values?: SubmittedValues;
  fieldErrors?: Record<number, string[]>;
  errors: { user?: string; email?: string; name?: string };
  /** utente scelto in precedenza (ripristino dopo un errore) */
  initialUser?: PickedUser | null;
  initialCcs?: PickedUser[];
}

/** Richiedente (esistente o nuovo), collaboratori in Cc e destinatari dell'avviso di apertura. */
export default function UserSection({ userForm, search, values, fieldErrors, errors, initialUser, initialCcs }: Props) {
  const t = useTranslations("createTicket");
  const [mode, setMode] = useState<"existing" | "new">(values && !first(values, "uid") && userForm ? "new" : "existing");
  const [user, setUser] = useState<PickedUser | null>(initialUser ?? null);
  const [ccs, setCcs] = useState<PickedUser[]>(initialCcs ?? []);
  const userErrors = [errors.user, errors.email, errors.name].filter((e): e is string => !!e);

  const tab = (m: "existing" | "new", label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className={cn(
        "rounded-lg px-3 py-1.5 text-sm font-medium",
        mode === m ? "bg-brand-500 text-white" : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5",
      )}
    >
      {label}
    </button>
  );

  return (
    <ComponentCard title={t("sections.user")}>
      {userForm && (
        <div className="flex gap-2">
          {tab("existing", t("user.existingUser"))}
          {tab("new", t("user.newUser"))}
        </div>
      )}
      {mode === "existing" ? (
        <FieldShell htmlFor="user-search" label={user ? t("user.selected") : t("user.search")} required errors={userErrors}>
          {user ? (
            <div className="flex items-center gap-3 rounded-lg border border-gray-200 px-4 py-2.5 text-sm dark:border-gray-800">
              <input type="hidden" name="uid" value={user.id} />
              <span className="text-gray-800 dark:text-white/90">{user.name}</span>
              <span className="text-gray-500 dark:text-gray-400">&lt;{user.email}&gt;</span>
              <button type="button" onClick={() => setUser(null)} className="ms-auto text-theme-xs text-brand-600 hover:underline dark:text-brand-400">
                {t("user.change")}
              </button>
            </div>
          ) : (
            <UserPicker id="user-search" placeholder={t("user.searchPlaceholder")} search={search} onPick={setUser} />
          )}
        </FieldShell>
      ) : (
        userForm && (
          <div className="space-y-4">
            <p className="text-theme-xs text-gray-500 dark:text-gray-400">{t("user.newUserHint")}</p>
            {userErrors.map((e) => (
              <p key={e} role="alert" className="text-theme-xs text-error-600 dark:text-error-400">
                {e}
              </p>
            ))}
            <DynamicForm form={userForm} values={values} errors={fieldErrors} />
          </div>
        )
      )}

      <FieldShell htmlFor="cc-search" label={t("user.ccs")}>
        {ccs.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {ccs.map((c) => (
              <li key={c.id} className="flex items-center gap-2 rounded-full bg-gray-100 px-3 py-1 text-theme-xs text-gray-700 dark:bg-white/5 dark:text-gray-300">
                <input type="hidden" name="ccs" value={c.id} />
                {c.name} &lt;{c.email}&gt;
                <button type="button" aria-label={t("user.remove")} onClick={() => setCcs((p) => p.filter((x) => x.id !== c.id))} className="text-gray-400 hover:text-error-500">
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <UserPicker
          id="cc-search"
          placeholder={t("user.ccsPlaceholder")}
          search={search}
          exclude={[...ccs.map((c) => c.id), ...(user ? [user.id] : [])]}
          onPick={(u) => setCcs((p) => [...p, u])}
        />
      </FieldShell>

      <FieldShell htmlFor="reply-to" label={t("user.notice")}>
        <select id="reply-to" name="reply-to" defaultValue={first(values, "reply-to") || "all"} className={selectCls}>
          <option value="all">{t("user.noticeAll")}</option>
          <option value="user">{t("user.noticeUser")}</option>
          <option value="none">{t("user.noticeNone")}</option>
        </select>
      </FieldShell>
    </ComponentCard>
  );
}
