"use client";

import { ChevronDown, Ellipsis } from "lucide-react";

import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/utils";
import BrandLogo from "@/components/brand/BrandLogo";
import { useBranding } from "@/context/BrandingContext";
import { useSearchParams } from "next/navigation";
import { useId, useMemo, useState } from "react";

import { useSidebar } from "../context/SidebarContext";
import type { NavChild, NavItem, NavSection } from "./nav-types";

interface Props {
  sections: NavSection[];
  homeHref: string;
}

/**
 * Voce attiva: percorso identico oppure sottopercorso (es. /agent/tickets/12 attiva "Ticket").
 * Se il link ha parametri (es. ?queue=2) devono coincidere con quelli della pagina corrente.
 */
function matches(pathname: string, href: string, exact?: boolean, search?: URLSearchParams): boolean {
  const [path, query] = href.split("?");
  if (query) {
    if (pathname !== path) return false;
    const want = new URLSearchParams(query);
    for (const [k, v] of want) if (search?.get(k) !== v) return false;
    return true;
  }
  if (exact) return pathname === path;
  return pathname === path || pathname.startsWith(path + "/");
}

/** Voce di sottomenu corrispondente alla pagina: il link, uno degli alias o la voce predefinita del percorso. */
function childMatches(c: NavChild, pathname: string, search: URLSearchParams): string | undefined {
  for (const href of [c.href, ...(c.alias ?? [])]) if (matches(pathname, href, c.exact, search)) return href;
  if (c.fallbackUnless && pathname === c.href.split("?")[0] && !c.fallbackUnless.some((k) => search.has(k))) return c.href;
  return undefined;
}

/**
 * Voce attiva di un sottomenu: fra quelle che corrispondono la più specifica (percorso più lungo), così
 * /admin/emails/diagnostic attiva "Diagnostica" e non anche "Indirizzi email" (/admin/emails).
 */
function activeChildHref(children: NavChild[], pathname: string, search: URLSearchParams): string | undefined {
  let best: string | undefined;
  let bestLen = -1;
  for (const c of children) {
    const hit = childMatches(c, pathname, search);
    const len = hit ? hit.split("?")[0].length : -1;
    if (hit && len > bestLen) {
      best = c.href;
      bestLen = len;
    }
  }
  return best;
}

/** Il gruppo contiene la pagina corrente: una sua voce è attiva oppure la pagina è nell'area del gruppo. */
function groupContains(item: NavItem, pathname: string, search: URLSearchParams): boolean {
  if (item.area && matches(pathname, item.area)) return true;
  return !!item.children && activeChildHref(item.children, pathname, search) !== undefined;
}

export default function AppSidebar({ sections, homeHref }: Props) {
  const { isExpanded, isMobileOpen, isHovered, setIsHovered } = useSidebar();
  const { sidebarStyle } = useBranding();
  const pathname = usePathname();
  const search = useSearchParams();
  const menuId = useId();
  const open = isExpanded || isHovered || isMobileOpen;
  // Sottomenu aperto: quello che contiene la pagina corrente, finché l'utente non ne apre/chiude uno
  const routeKey = useMemo(() => {
    for (const section of sections) for (const item of section.items) if (item.children?.length && groupContains(item, pathname, search)) return item.key;
    return null;
  }, [pathname, sections, search]);
  const [userKey, setUserKey] = useState<string | null | undefined>(undefined);
  const [prevPath, setPrevPath] = useState(pathname);
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    setUserKey(undefined);
  }
  const openKey = userKey === undefined ? routeKey : userKey;
  const setOpenKey = setUserKey;

  const renderItem = (item: NavItem) => {
    if (item.children?.length) {
      const isOpen = openKey === item.key;
      // evidenziato se contiene la pagina corrente, indipendentemente dall'apertura del sottomenu
      const current = groupContains(item, pathname, search);
      const activeHref = activeChildHref(item.children, pathname, search);
      const panelId = `${menuId}-${item.key}`;
      return (
        <li key={item.key}>
          <button
            type="button"
            onClick={() => setOpenKey(isOpen ? null : item.key)}
            aria-expanded={open ? isOpen : undefined}
            aria-controls={open ? panelId : undefined}
            aria-label={open ? undefined : item.label}
            className={cn("group menu-item cursor-pointer", current ? "menu-item-active" : "menu-item-inactive", !isExpanded && !isHovered ? "lg:justify-center" : "lg:justify-start")}
          >
            <span className={current ? "menu-item-icon-active" : "menu-item-icon-inactive"}>{item.icon}</span>
            {open && <span className="menu-item-text">{item.label}</span>}
            {open && <ChevronDown aria-hidden="true" className={cn("ms-auto h-5 w-5 transition-transform duration-200", isOpen && "rotate-180 text-brand-500")} />}
          </button>
          {open && (
            // Griglia 0fr/1fr: niente misura dell'altezza, il sottomenu aperto al primo render compare già aperto
            // (nessuna animazione al caricamento) e anima solo quando l'utente lo apre o lo chiude
            <div id={panelId} className={cn("grid transition-[grid-template-rows] duration-300", isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")} inert={!isOpen}>
              <div className="min-h-0 overflow-hidden">
                <ul className="ms-9 mt-2 space-y-1">
                  {item.children.map((child) => {
                    const active = child.href === activeHref;
                    return (
                      <li key={child.href}>
                        <Link
                          href={child.href}
                          aria-current={active ? "page" : undefined}
                          className={cn("menu-dropdown-item", active ? "menu-dropdown-item-active" : "menu-dropdown-item-inactive")}
                        >
                          {child.label}
                          {child.badge !== undefined && (
                            <span className={cn("ms-auto menu-dropdown-badge", active ? "menu-dropdown-badge-active" : "menu-dropdown-badge-inactive")}>{child.badge}</span>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}
        </li>
      );
    }

    const active = item.href ? matches(pathname, item.href, item.exact, search) : false;
    const className = cn(
      "group menu-item",
      active ? "menu-item-active" : "menu-item-inactive",
      !isExpanded && !isHovered ? "lg:justify-center" : "lg:justify-start",
    );
    const content = (
      <>
        <span className={active ? "menu-item-icon-active" : "menu-item-icon-inactive"}>{item.icon}</span>
        {open && <span className="menu-item-text">{item.label}</span>}
      </>
    );
    return (
      <li key={item.key}>
        {item.external ? (
          <a href={item.href} className={className} aria-label={open ? undefined : item.label}>
            {content}
          </a>
        ) : (
          <Link href={item.href ?? "#"} className={className} aria-current={active ? "page" : undefined} aria-label={open ? undefined : item.label}>
            {content}
          </Link>
        )}
      </li>
    );
  };

  return (
    <div className={sidebarStyle === "light" ? undefined : "dark"}>
      <aside
        className={cn(
          "fixed start-0 top-0 z-50 flex h-full flex-col border-e border-gray-200 bg-white px-5 text-gray-900 transition-[width,translate] duration-300 ease-in-out xl:mt-0 dark:border-gray-800 dark:bg-gray-900",
          open ? "w-72.5" : "w-22.5",
          isMobileOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full",
          "xl:translate-x-0 xl:rtl:translate-x-0",
        )}
        style={
          sidebarStyle === "brand"
            ? {
                backgroundColor: "var(--color-brand-950)",
                borderColor: "var(--color-brand-900)",
              }
            : undefined
        }
        onMouseEnter={() => !isExpanded && setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <div className={cn("flex py-8", !isExpanded && !isHovered ? "xl:justify-center" : "justify-start")}>
          <Link href={homeHref}>{open ? <BrandLogo height={44} forceDark={sidebarStyle !== "light"} /> : <BrandLogo variant="icon" height={36} />}</Link>
        </div>
        <div className="no-scrollbar flex flex-col overflow-y-auto duration-300 ease-linear">
          <nav className="mb-6">
            <div className="flex flex-col gap-4">
              {sections.map((section) => (
                <div key={section.title}>
                  <h2 className={cn("mb-4 flex text-xs leading-5 text-gray-400 uppercase", !isExpanded && !isHovered ? "xl:justify-center" : "justify-start")}>
                    {open ? section.title : <Ellipsis className="size-5" />}
                  </h2>
                  <ul className="flex flex-col gap-1">{section.items.map(renderItem)}</ul>
                </div>
              ))}
            </div>
          </nav>
        </div>
      </aside>
    </div>
  );
}
