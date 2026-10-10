"use client";

import LanguageSwitcher from "@/components/common/LanguageSwitcher";
import { Dropdown } from "@/components/ui/dropdown/Dropdown";
import { Link } from "@/i18n/navigation";
import { ChevronDownIcon } from "@/icons";
import type { ShellUser } from "@/layout/nav-types";
import { cn } from "@/utils";
import { useTranslations } from "next-intl";
import { useCallback, useId, useRef, useState } from "react";

interface Props {
  user: ShellUser;
  logoutAction: () => Promise<void>;
  links: { label: string; href: string; external?: boolean }[];
}

export default function UserMenu({ user, logoutAction, links }: Props) {
  const t = useTranslations("header");
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const itemClass =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start font-medium text-gray-700 text-theme-sm hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-300";

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="dropdown-toggle flex items-center text-gray-700 dark:text-gray-400"
      >
        <span className="me-3 flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">
          {user.initials}
        </span>
        <span className="me-1 block text-theme-sm font-medium">{user.name}</span>
        <ChevronDownIcon aria-hidden="true" className={cn("size-5 text-gray-500 transition-transform duration-200 dark:text-gray-400", open && "rotate-180")} />
      </button>

      <Dropdown
        id={panelId}
        isOpen={open}
        onClose={close}
        triggerRef={triggerRef}
        className="absolute end-0 mt-4.25 flex w-65 flex-col rounded-2xl border border-gray-200 bg-white p-3 shadow-theme-lg dark:border-gray-800 dark:bg-gray-dark"
      >
        <div>
          <span className="block text-theme-sm font-medium text-gray-700 dark:text-gray-400">{user.name}</span>
          <span className="mt-0.5 block text-theme-xs text-gray-500 dark:text-gray-400">{user.email}</span>
          {user.subtitle && <span className="mt-0.5 block text-theme-xs text-brand-500">{user.subtitle}</span>}
        </div>

        <ul className="flex flex-col gap-1 border-b border-gray-200 pt-4 pb-3 dark:border-gray-800">
          {links.map((link) => (
            <li key={link.href}>
              {link.external ? (
                <a href={link.href} className={itemClass}>
                  {link.label}
                </a>
              ) : (
                <Link href={link.href} className={itemClass} onClick={() => setOpen(false)}>
                  {link.label}
                </Link>
              )}
            </li>
          ))}
          <li className="px-3 pt-2 text-theme-xs text-gray-500 dark:text-gray-400">{t("language")}</li>
          <li className="px-3">
            <LanguageSwitcher />
          </li>
        </ul>
        <form action={logoutAction}>
          <button type="submit" className={cn(itemClass, "mt-3")}>
            {t("signOut")}
          </button>
        </form>
      </Dropdown>
    </div>
  );
}
