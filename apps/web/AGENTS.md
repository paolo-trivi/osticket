# AGENTS.md — TailTicket (apps/web)

> Nuovo frontend Next.js di osTicket sullo **stesso database** del PHP · base grafica TailAdmin · Tailwind CSS v4 · next-intl

## Regole di progetto (prevalgono su quelle del template)
- Leggere `README.md` (regole di coesistenza) e `../../docs/reverse-engineering/` prima di toccare il dominio.
- Il doc 17 §3 (contratti di scrittura) si genera da `docs/contract/*.md` con `npm run docs:contracts`: modificare i file di contratto, mai il doc 17 a mano (la CI lo verifica).
- Mai DDL sul DB osTicket. Ogni scrittura deve riprodurre le righe che scrive il PHP: verificare con il codice `../../legacy/include/class.*.php` e con l'harness differenziale.
- Accesso al DB solo da `src/server/**` (file con `import "server-only"`), tramite i servizi in `src/server/domain/`.
- Costanti di bit/flag e codici dei tipi di oggetto del PHP: solo da `src/lib/osticket/{flags,object-types}.ts` (mai numeri magici o copie locali).
- Nomi tabella senza prefisso in Kysely (`selectFrom("ticket")`); non usare alias uguali a nomi di tabella; nelle query `sql```...``` usare `table("ticket")`.
- Datetime: stringhe nel fuso del DB, conversioni solo con `src/server/db/time.ts`; `NOW` per created/updated.
- Lingue: `it` (default) ed `en`; ogni testo visibile va in `src/messages/*.json`.
- Le pagine protette chiamano `requireAgent()` anche se il layout lo fa già.

## Repo Map

```
src/
├── app/
│   ├── [locale]/
│   │   ├── (staff)/agent/        # pannello agenti: login/, (panel)/ con sidebar, guard.ts, nav.tsx, actions.ts
│   │   ├── (staff)/admin/        # area amministrazione (solo isadmin): theme/ …
│   │   ├── layout.tsx            # tema dal DB (config nextui.theme), font, provider
│   │   └── not-found.tsx
│   └── api/branding/[kind]/      # loghi caricati in osTicket (staff/client/backdrop)
├── components/
│   ├── brand/                    # BrandLogo (TailTicket o logo caricato)
│   ├── shell/                    # AppShell, UserMenu, AuthLayout
│   ├── ui/, form/, common/       # primitive grafiche
├── context/                      # Sidebar, Theme (chiaro/scuro), Branding (tema configurato)
├── lib/                          # codice condiviso client/server: theme/ (schema, palette, css), fonts, osticket/ (flag e tipi di oggetto del PHP)
├── server/                       # SOLO server: db/, config/, auth/, domain/, theme/, format/, system/
├── i18n/, messages/              # it (default), en
├── layout/                       # AppSidebar, AppHeader, nav-types
└── icons/
```

## Stack

- **Next.js 16** (App Router, Turbopack + webpack both configured) with **React 19** and strict **TypeScript**.
- **next-intl v4** for internationalization (i18n), localized routing, and RTL support.
- Path alias: `@/*` → `src/*`.
- Scripts: `npm run dev`, `npm run build`, `npm run lint`. Node >= 20.9.
- This Next.js version may differ from your training data — read the relevant guide in `node_modules/next/dist/docs/` before writing code and heed deprecation notices.

## Conventions

- **New page** → add a folder under the matching `src/app/[locale]/(...)/` group; colocate route-only components there. Never place pages outside `[locale]`.
- **New reusable component** → `components/<feature>/` if domain-specific, else `components/common/` or `components/ui/`.
- **New icon** → drop the `.svg` in `icons/`, export it from the `index.tsx` barrel with a PascalCase name. Never inline SVG markup in components.
- Route groups: `(staff)` contiene pannello agenti e area admin; il guscio con sidebar è `components/shell/AppShell`.
- Component files are **PascalCase** (`TicketCell.tsx`) with a **default export**; route files stay lowercase (`page.tsx`, `layout.tsx`); hooks are camelCase (`useBoardDrag.ts`).
- Root `app/[locale]/layout.tsx` is a Server Component setting up `NextIntlClientProvider`, fonts, direction (`dir="ltr"|"rtl"`), and providers. The `(admin)` shell layout and interactive UI are Client Components — add `"use client"` whenever using hooks, event handlers, or browser APIs.
- Import via the alias (`@/context/...`, `@/icons/...`, `@/i18n/...`) for cross-folder imports; relative imports are fine within a feature folder.

## Internationalization (next-intl) rules

- **Navigation & Routing**: Always import navigation primitives (`Link`, `useRouter`, `usePathname`, `redirect`) from `@/i18n/navigation`, never directly from `next/link` or `next/navigation`.
- **Routing Configuration**: Locales (`it`, `en`) and routing settings are centralized in `src/i18n/routing.ts` (`localePrefix: "never"`).
- **Translations**:
  - In Client Components: use `useTranslations("namespace")`.
  - In Server Components: use `getTranslations("namespace")` from `next-intl/server`.
  - Organize translation keys by nested feature namespaces (e.g. `t("sources.Phone")` under `ticketEdit`).
- **Translation Messages**: All translation dictionaries live in `src/messages/<locale>.json`. When adding or updating user-facing copy, maintain corresponding keys across all supported language files.
- **Static Rendering & Server Components**: Server layouts/pages inside `[locale]` must call `setRequestLocale(locale)` to enable static rendering with `generateStaticParams()`.
- **RTL Support**: Arabic (`ar`) uses RTL direction (`dir="rtl"`) via `isRtl(locale)` in `src/i18n/languages.ts`. Ensure UI components handle RTL layouts gracefully using CSS logical properties and `rtl:` variants.

## Styling rules

- Tailwind CSS **v4** — the theme lives in `src/app/globals.css` under `@theme`; there is no `tailwind.config`.
- Always use theme tokens instead of hardcoded values:
  - Colors: `brand`, `gray`, `blue-light`, `orange`, `success`, `error`, `warning` scales (`25`–`950`), plus `theme-pink-500` / `theme-purple-500`.
  - Typography: `font-outfit`, `text-theme-xs/sm/xl`, `text-title-sm/md/lg/xl/2xl`.
  - Shadows: `shadow-theme-xs/sm/md/lg/xl`, `shadow-focus-ring`, `shadow-slider-navigation`, `shadow-tooltip`, `shadow-datepicker`.
  - Breakpoints: custom `2xsm` (375px), `xsm` (425px), `3xl` (2000px) alongside the defaults.
  - Z-index: `z-1`, `z-9`, `z-99`, … `z-999999` tokens.
- **Dark mode is class-based** (`@custom-variant dark (&:is(.dark *))`, driven by `ThemeContext` with light/dark/auto). Every styled element must include its `dark:` variant.
- **CSS Logical Properties for RTL & Internationalization**:
  - Never use physical directional utilities when logical equivalents exist; physical `left`/`right` properties break in RTL (`ar`) layout:
    - **Margins**: Use `ms-*` / `me-*` (margin-inline start/end) instead of `ml-*` / `mr-*`.
    - **Padding**: Use `ps-*` / `pe-*` (padding-inline start/end) instead of `pl-*` / `pr-*`.
    - **Positioning / Insets**: Use `start-*` / `end-*` instead of `left-*` / `right-*`.
    - **Borders**: Use `border-s-*` / `border-e-*` instead of `border-l-*` / `border-r-*`.
    - **Border Radius**: Use `rounded-s-*` / `rounded-e-*` / `rounded-ss-*` / `rounded-se-*` / `rounded-es-*` / `rounded-ee-*` instead of `rounded-l-*` / `rounded-r-*` / `rounded-t-*` corner combos.
    - **Text Alignment**: Use `text-start` / `text-end` instead of `text-left` / `text-right`.
  - **Directional Icons & Transforms**:
    - Directional glyphs (e.g. back/forward arrows, breadcrumb chevrons, next/prev icons) must flip in RTL with `rtl:rotate-180` or `rtl:-scale-x-100`.
    - Off-canvas drawers and sliding elements must mirror their translation (e.g., `-translate-x-full rtl:translate-x-full`).
    - Use `ltr:*` and `rtl:*` modifiers when explicit directional overrides or third-party integration styles are required.
- Reusable `@utility` classes already exist in `globals.css` (`menu-item-*`, `menu-dropdown-*`, `custom-scrollbar`, `no-scrollbar`, …) — reuse them before inventing new ones.
- Third-party CSS overrides (ApexCharts, flatpickr) live at the bottom of `globals.css`. Add overrides there, matching the existing `@apply` style.
- Never hardcode hex colors in `className`. (Chart option objects like `ApexOptions.colors` are the established exception — copy hex values from the `@theme` palette, e.g. `#465fff` = brand-500.)

## Component rules

- **One feature, one folder**: new page UI goes in `src/components/<feature>/`, split into focused single-responsibility sub-components (e.g. `board/BoardToolbar.tsx`, `board/BoardCardItem.tsx`) — never one monolithic file.
- **Composition over prop drilling**: pass `children`, keep container/state logic separate from presentational components, extract section-level JSX into its own file, and define explicit typed prop interfaces per sub-component.
- Prefer primitives from `src/components/ui/` and `src/components/form/` over raw HTML or new third-party equivalents.
- Wrap page sections in `ComponentCard`.
- I colori del marchio (`brand-*`) sono configurabili dall'admin: usare sempre i token `brand-*`, mai colori fissi.
- **Charts**: `react-apexcharts` must be dynamically imported — `const ReactApexChart = dynamic(() => import("react-apexcharts"), { ssr: false })`.
- **Icons**: import from `@/icons` (SVGs are compiled to React components via `@svgr/webpack`, configured for both webpack and Turbopack).
- Modals use `@/components/ui/modal` with local `useState` for open/close.
- Global state goes through the existing contexts (`useSidebar`, `useTheme`) — don't add new providers without need.

## Don'ts

- Don't import `Link`, `useRouter`, `usePathname`, or `redirect` from `next/link` or `next/navigation` — always use `@/i18n/navigation`.
- Don't create pages directly under `src/app/` outside the `[locale]` segment.
- Don't hardcode user-facing text without adding keys to `src/messages/*.json`.
- Don't use physical directional utilities (`ml-*`, `mr-*`, `pl-*`, `pr-*`, `left-*`, `right-*`, `border-l-*`, `border-r-*`, `rounded-l-*`, `rounded-r-*`, `text-left`, `text-right`) — always use CSS logical equivalents (`ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `end-*`, `border-s-*`, `border-e-*`, `rounded-s-*`, `rounded-e-*`, `text-start`, `text-end`).
- Don't hardcode hex colors or pixel values in `className` — use the `@theme` tokens.
- Don't create a `tailwind.config` — Tailwind v4 is configured through `globals.css`.
- Don't import `react-apexcharts` statically — always use `next/dynamic` with `ssr: false`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
