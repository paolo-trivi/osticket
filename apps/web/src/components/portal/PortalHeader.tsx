"use client";

import { useState } from "react";

import { useTranslations } from "next-intl";

import BrandLogo from "@/components/brand/BrandLogo";
import LanguageSwitcher from "@/components/common/LanguageSwitcher";
import { ThemeToggleButton } from "@/components/common/ThemeToggleButton";
import { Link, usePathname } from "@/i18n/navigation";
import { CloseIcon, ListIcon } from "@/icons";
import { cn } from "@/utils";

export interface PortalNavItem {
  key: "home" | "kb" | "open" | "tickets" | "status" | "profile";
  href: string;
}

interface Props {
  items: PortalNavItem[];
  /** cliente autenticato (nome) o null */
  user: { name: string; guest: boolean } | null;
  showLogin: boolean;
  logoutAction: () => Promise<void>;
}

/** Testata del portale clienti (include/client/header.inc.php): logo, menu, lingua, accesso/uscita. */
export default function PortalHeader({ items, user, showLogin, logoutAction }: Props) {
  const t = useTranslations("portal.nav");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const active = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));

  const linkClass = (href: string) =>
    cn(
      "rounded-lg px-3 py-2 text-theme-sm font-medium transition-colors",
      active(href)
        ? "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400"
        : "text-gray-600 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-300 dark:hover:bg-white/5 dark:hover:text-white",
    );

  return (
    <header className="sticky top-0 z-99 border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center" aria-label={t("home")}>
          <BrandLogo audience="client" height={40} />
        </Link>

        <nav className="hidden items-center gap-1 lg:flex" aria-label={t("label")}>
          {items.map((i) => (
            <Link key={i.key} href={i.href} className={linkClass(i.href)}>
              {t(i.key)}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <LanguageSwitcher className="hidden sm:flex" />
          <ThemeToggleButton />
          {user ? (
            <div className="hidden items-center gap-3 sm:flex">
              <span className="text-theme-sm text-gray-600 dark:text-gray-300">
                {user.name}
                {user.guest && <span className="ms-1 text-theme-xs text-gray-400">({t("guest")})</span>}
              </span>
              <form action={logoutAction}>
                <button type="submit" className="rounded-lg border border-gray-300 px-3 py-2 text-theme-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5">
                  {t("logout")}
                </button>
              </form>
            </div>
          ) : (
            showLogin && (
              <Link href="/login" className="hidden rounded-lg bg-brand-500 px-4 py-2 text-theme-sm font-medium text-white shadow-theme-xs hover:bg-brand-600 sm:inline-block">
                {t("login")}
              </Link>
            )
          )}
          <button
            type="button"
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-gray-200 text-gray-500 lg:hidden dark:border-gray-800 dark:text-gray-400"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={t("menu")}
          >
            {open ? <CloseIcon aria-hidden="true" className="size-5 fill-current" /> : <ListIcon aria-hidden="true" className="size-5" />}
          </button>
        </div>
      </div>

      {open && (
        <nav className="border-t border-gray-200 px-4 py-3 lg:hidden dark:border-gray-800" aria-label={t("label")}>
          <div className="flex flex-col gap-1">
            {items.map((i) => (
              <Link key={i.key} href={i.href} className={linkClass(i.href)} onClick={() => setOpen(false)}>
                {t(i.key)}
              </Link>
            ))}
            {user ? (
              <form action={logoutAction}>
                <button type="submit" className="w-full rounded-lg px-3 py-2 text-start text-theme-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5">
                  {t("logout")}
                </button>
              </form>
            ) : (
              showLogin && (
                <Link href="/login" className={linkClass("/login")} onClick={() => setOpen(false)}>
                  {t("login")}
                </Link>
              )
            )}
            <LanguageSwitcher className="px-3 pt-2 sm:hidden" />
          </div>
        </nav>
      )}
    </header>
  );
}
