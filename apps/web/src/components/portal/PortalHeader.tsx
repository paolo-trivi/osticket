"use client";

import { useEffect, useId, useRef, useState } from "react";

import { useTranslations } from "next-intl";

import BrandLogo from "@/components/brand/BrandLogo";
import LanguageSwitcher from "@/components/common/LanguageSwitcher";
import { ThemeToggleButton } from "@/components/common/ThemeToggleButton";
import WriteModeBanner from "@/components/shell/WriteModeBanner";
import { Link, usePathname } from "@/i18n/navigation";
import { Menu, X } from "lucide-react";
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

/**
 * Testata del portale clienti (include/client/header.inc.php): logo, menu, lingua, accesso/uscita e,
 * in sola lettura, l'avviso di sola consultazione.
 */
export default function PortalHeader({ items, user, showLogin, logoutAction }: Props) {
  const t = useTranslations("portal.nav");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // hash della pagina letto all'apertura del menu mobile (usePathname non lo include)
  const [hash, setHash] = useState("");
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const pathActive = (path: string) => (path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`));
  /**
   * /login contiene sia l'accesso con account sia la verifica dello stato (#access). Nella barra (dove
   * "Accedi" è un pulsante, non una voce) "Stato del ticket" è attivo su /login: deciso dal solo percorso,
   * quindi identico fra server e client, senza lampeggi. Nel menu mobile, aperto dopo il caricamento, conta
   * l'hash: "Stato del ticket" con #access (o senza accesso con account), altrimenti "Accedi".
   */
  const active = (href: string, mobile = false) => {
    const [path, anchor] = href.split("#");
    if (!pathActive(path)) return false;
    if (!mobile || path !== "/login") return true;
    const statusActive = hash === "#access" || !showLogin;
    return anchor === "access" ? statusActive : !statusActive;
  };

  // Esc chiude il menu mobile e riporta il focus sul pulsante
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const linkClass = (href: string, mobile = false) =>
    cn(
      "rounded-lg px-3 py-2 text-theme-sm font-medium transition-colors",
      active(href, mobile)
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
            <Link key={i.key} href={i.href} className={linkClass(i.href)} aria-current={active(i.href) ? "page" : undefined}>
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
            ref={toggleRef}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-gray-200 text-gray-500 lg:hidden dark:border-gray-800 dark:text-gray-400"
            onClick={() => {
              setHash(window.location.hash);
              setOpen((v) => !v);
            }}
            aria-expanded={open}
            aria-controls={menuId}
            aria-label={t("menu")}
          >
            {open ? <X aria-hidden="true" className="size-5" /> : <Menu aria-hidden="true" className="size-5" />}
          </button>
        </div>
      </div>

      {/* sempre nel DOM (nascosto da chiuso): aria-controls del pulsante punta sempre a un elemento */}
      <nav id={menuId} hidden={!open} className="border-t border-gray-200 px-4 py-3 lg:hidden dark:border-gray-800" aria-label={t("label")}>
        <div className="flex flex-col gap-1">
          {items.map((i) => (
            <Link key={i.key} href={i.href} className={linkClass(i.href, true)} aria-current={active(i.href, true) ? "page" : undefined} onClick={() => setOpen(false)}>
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
              <Link href="/login" className={linkClass("/login", true)} aria-current={active("/login", true) ? "page" : undefined} onClick={() => setOpen(false)}>
                {t("login")}
              </Link>
            )
          )}
          <LanguageSwitcher className="px-3 pt-2 sm:hidden" />
        </div>
      </nav>
      {/* sola consultazione: avviso per i clienti (nulla se il portale può scrivere) */}
      <WriteModeBanner area="portal" className="border-t" innerClassName="mx-auto max-w-6xl px-4 sm:px-6" />
    </header>
  );
}
