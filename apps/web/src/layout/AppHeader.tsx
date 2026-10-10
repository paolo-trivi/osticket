"use client";

import { Command, Ellipsis, Menu, PanelLeft, Search, X } from "lucide-react";
import BrandLogo from "@/components/brand/BrandLogo";
import { ThemeToggleButton } from "@/components/common/ThemeToggleButton";
import UserMenu from "@/components/shell/UserMenu";
import { useSidebar } from "@/context/SidebarContext";
import { Link, useRouter } from "@/i18n/navigation";
import { cn } from "@/utils";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import type { ShellUser } from "./nav-types";

interface Props {
  user: ShellUser;
  /** pagina che riceve ?q= dalla ricerca rapida; se assente la ricerca non viene mostrata */
  searchHref?: string;
  logoutAction: () => Promise<void>;
  menuLinks?: { label: string; href: string; external?: boolean }[];
}

export default function AppHeader({ user, searchHref, logoutAction, menuLinks = [] }: Props) {
  const t = useTranslations("header");
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { isMobileOpen, toggleSidebar, toggleMobileSidebar } = useSidebar();

  const handleToggle = () => {
    if (window.innerWidth >= 1280) toggleSidebar();
    else toggleMobileSidebar();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="sticky top-0 z-99999 flex w-full border-gray-200 bg-white xl:border-b dark:border-gray-800 dark:bg-gray-900">
      <div className="flex grow flex-col items-center justify-between xl:flex-row xl:px-6">
        <div className="flex w-full items-center justify-between gap-2 border-b border-gray-200 px-3 py-3 sm:gap-4 xl:justify-normal xl:border-b-0 xl:px-0 xl:py-4 dark:border-gray-800">
          <button
            type="button"
            className={cn(
              "z-99999 flex h-10 w-10 items-center justify-center rounded-lg border-gray-200 text-gray-500 lg:h-11 lg:w-11 xl:border dark:border-gray-800 dark:text-gray-400",
              isMobileOpen && "bg-gray-100 dark:bg-white/3",
            )}
            onClick={handleToggle}
            aria-label={t("toggleSidebar")}
          >
            {/* da telefono e tablet apre il menu laterale, da desktop comprime la sidebar */}
            {isMobileOpen ? <X className="size-5 xl:hidden" /> : <Menu className="size-5 xl:hidden" />}
            <PanelLeft className="hidden size-5 xl:block rtl:-scale-x-100" />
          </button>

          {/* marchio visibile quando la sidebar è nascosta (mobile e tablet) */}
          <Link href="/agent" className="xl:hidden" aria-label={t("home")}>
            <BrandLogo height={32} />
          </Link>

          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            className="z-99999 flex h-10 w-10 items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100 xl:hidden dark:text-gray-400 dark:hover:bg-gray-800"
            aria-label={t("menu")}
          >
            <Ellipsis className="size-6" />
          </button>

          {searchHref && (
            <div className="hidden xl:block">
              <form
                role="search"
                onSubmit={(e) => {
                  e.preventDefault();
                  const q = inputRef.current?.value.trim();
                  router.push(q ? `${searchHref}?q=${encodeURIComponent(q)}` : searchHref);
                }}
              >
                <div className="relative">
                  <span className="pointer-events-none absolute start-4 top-1/2 -translate-y-1/2">
                    <Search className="size-5 text-gray-500 dark:text-gray-400" />
                  </span>
                  <input
                    ref={inputRef}
                    type="search"
                    name="q"
                    aria-label={t("searchLabel")}
                    placeholder={t("searchPlaceholder")}
                    className="h-11 w-full rounded-lg border border-gray-200 bg-transparent py-2.5 ps-12 pe-14 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden xl:w-107.5 dark:border-gray-800 dark:bg-white/3 dark:text-white/90 dark:placeholder:text-white/30 dark:focus:border-brand-800"
                  />
                  <span
                    aria-hidden="true"
                    className="absolute end-2.5 top-1/2 inline-flex -translate-y-1/2 items-center gap-0.5 rounded-lg border border-gray-200 bg-gray-50 px-1.75 py-[4.5px] text-xs text-gray-500 dark:border-gray-800 dark:bg-white/3 dark:text-gray-400"
                  >
                    <Command className="size-3" /> K
                  </span>
                </div>
              </form>
            </div>
          )}
        </div>
        <div
          className={cn(
            "w-full items-center justify-between gap-4 px-5 py-4 shadow-theme-md xl:flex xl:justify-end xl:px-0 xl:shadow-none",
            mobileMenuOpen ? "flex" : "hidden",
          )}
        >
          <div className="flex items-center gap-2 2xsm:gap-3">
            <ThemeToggleButton />
          </div>
          <UserMenu user={user} logoutAction={logoutAction} links={menuLinks} />
        </div>
      </div>
    </header>
  );
}
