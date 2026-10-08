"use client";

import { Link, usePathname } from "@/i18n/navigation";
import { ChevronDownIcon, HorizontaLDots } from "@/icons";
import { cn } from "@/utils";
import BrandLogo from "@/components/brand/BrandLogo";
import { useEffect, useMemo, useRef, useState } from "react";

import { useSidebar } from "../context/SidebarContext";
import type { NavItem, NavSection } from "./nav-types";

interface Props {
  sections: NavSection[];
  homeHref: string;
}

/** Voce attiva: percorso identico oppure sottopercorso (es. /agent/tickets/12 attiva "Ticket"). */
function matches(pathname: string, href: string, exact?: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

export default function AppSidebar({ sections, homeHref }: Props) {
  const { isExpanded, isMobileOpen, isHovered, setIsHovered } = useSidebar();
  const pathname = usePathname();
  const open = isExpanded || isHovered || isMobileOpen;
  // Sottomenu aperto: quello che contiene la pagina corrente, finché l'utente non ne apre/chiude uno
  const routeKey = useMemo(() => {
    for (const section of sections)
      for (const item of section.items)
        if (item.children?.some((c) => matches(pathname, c.href, c.exact))) return item.key;
    return null;
  }, [pathname, sections]);
  const [userKey, setUserKey] = useState<string | null | undefined>(undefined);
  const [prevPath, setPrevPath] = useState(pathname);
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    setUserKey(undefined);
  }
  const openKey = userKey === undefined ? routeKey : userKey;
  const setOpenKey = setUserKey;
  const [heights, setHeights] = useState<Record<string, number>>({});
  const refs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (openKey && refs.current[openKey]) {
      setHeights((h) => ({ ...h, [openKey]: refs.current[openKey]?.scrollHeight ?? 0 }));
    }
  }, [openKey]);

  const renderItem = (item: NavItem) => {
    if (item.children?.length) {
      const isOpen = openKey === item.key;
      return (
        <li key={item.key}>
          <button
            type="button"
            onClick={() => setOpenKey(isOpen ? null : item.key)}
            className={cn(
              "group menu-item cursor-pointer",
              isOpen ? "menu-item-active" : "menu-item-inactive",
              !isExpanded && !isHovered ? "lg:justify-center" : "lg:justify-start",
            )}
          >
            <span className={isOpen ? "menu-item-icon-active" : "menu-item-icon-inactive"}>{item.icon}</span>
            {open && <span className="menu-item-text">{item.label}</span>}
            {open && (
              <ChevronDownIcon
                className={cn("ms-auto h-5 w-5 transition-transform duration-200", isOpen && "rotate-180 text-brand-500")}
              />
            )}
          </button>
          {open && (
            <div
              ref={(el) => {
                refs.current[item.key] = el;
              }}
              className="overflow-hidden transition-all duration-300"
              style={{ height: isOpen ? `${heights[item.key] ?? 0}px` : "0px" }}
            >
              <ul className="ms-9 mt-2 space-y-1">
                {item.children.map((child) => {
                  const active = matches(pathname, child.href, child.exact);
                  return (
                    <li key={child.href}>
                      <Link
                        href={child.href}
                        className={cn(
                          "menu-dropdown-item",
                          active ? "menu-dropdown-item-active" : "menu-dropdown-item-inactive",
                        )}
                      >
                        {child.label}
                        {child.badge !== undefined && (
                          <span
                            className={cn(
                              "ms-auto menu-dropdown-badge",
                              active ? "menu-dropdown-badge-active" : "menu-dropdown-badge-inactive",
                            )}
                          >
                            {child.badge}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </li>
      );
    }

    const active = item.href ? matches(pathname, item.href, item.exact) : false;
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
          <a href={item.href} className={className}>
            {content}
          </a>
        ) : (
          <Link href={item.href ?? "#"} className={className}>
            {content}
          </Link>
        )}
      </li>
    );
  };

  return (
    <aside
      className={cn(
        "fixed top-0 start-0 z-50 flex h-full flex-col border-e border-gray-200 bg-white px-5 text-gray-900 transition-all duration-300 ease-in-out xl:mt-0 dark:border-gray-800 dark:bg-gray-900",
        open ? "w-72.5" : "w-22.5",
        isMobileOpen ? "translate-x-0" : "-translate-x-full rtl:translate-x-full",
        "xl:translate-x-0 xl:rtl:translate-x-0",
      )}
      onMouseEnter={() => !isExpanded && setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className={cn("flex py-8", !isExpanded && !isHovered ? "xl:justify-center" : "justify-start")}>
        <Link href={homeHref}>
          {open ? <BrandLogo height={44} /> : <BrandLogo variant="icon" height={36} />}
        </Link>
      </div>
      <div className="no-scrollbar flex flex-col overflow-y-auto duration-300 ease-linear">
        <nav className="mb-6">
          <div className="flex flex-col gap-4">
            {sections.map((section) => (
              <div key={section.title}>
                <h2
                  className={cn(
                    "mb-4 flex text-xs leading-5 text-gray-400 uppercase",
                    !isExpanded && !isHovered ? "xl:justify-center" : "justify-start",
                  )}
                >
                  {open ? section.title : <HorizontaLDots />}
                </h2>
                <ul className="flex flex-col gap-1">{section.items.map(renderItem)}</ul>
              </div>
            ))}
          </div>
        </nav>
      </div>
    </aside>
  );
}
