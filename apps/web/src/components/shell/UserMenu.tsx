"use client";

import { Dropdown } from "@/components/ui/dropdown/Dropdown";
import { languages } from "@/i18n/languages";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { ChevronDownIcon } from "@/icons";
import type { ShellUser } from "@/layout/nav-types";
import { cn } from "@/utils";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

interface Props {
  user: ShellUser;
  logoutAction: () => Promise<void>;
  links: { label: string; href: string; external?: boolean }[];
}

export default function UserMenu({ user, logoutAction, links }: Props) {
  const t = useTranslations("header");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const itemClass =
    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start font-medium text-gray-700 text-theme-sm hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-gray-300";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="dropdown-toggle flex items-center text-gray-700 dark:text-gray-400"
      >
        <span className="me-3 flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">
          {user.initials}
        </span>
        <span className="me-1 block text-theme-sm font-medium">{user.name}</span>
        <ChevronDownIcon className={cn("size-5 text-gray-500 transition-transform duration-200 dark:text-gray-400", open && "rotate-180")} />
      </button>

      <Dropdown
        isOpen={open}
        onClose={() => setOpen(false)}
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
          <li className="flex gap-2 px-3">
            {languages.map(({ id, shortName, FlagIcon }) => (
              <button
                key={id}
                type="button"
                onClick={() => router.replace(pathname, { locale: id })}
                className={cn(
                  "flex items-center gap-1 rounded-md border px-2 py-1 text-theme-xs",
                  id === locale
                    ? "border-brand-300 text-brand-600 dark:border-brand-700 dark:text-brand-400"
                    : "border-gray-200 text-gray-600 dark:border-gray-800 dark:text-gray-400",
                )}
              >
                <FlagIcon className="size-4" />
                {shortName}
              </button>
            ))}
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
