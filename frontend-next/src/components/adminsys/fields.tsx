import type { ReactNode } from "react";

import ComponentCard from "@/components/common/ComponentCard";
import { cn } from "@/utils";

/**
 * Campi dei form adminsys (senza stato: usabili da server e client component). I nomi sono quelli
 * del POST di osTicket.
 */
export const controlClass =
  "w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:placeholder:text-white/30";

export interface Opt {
  value: string;
  label: string;
  disabled?: boolean;
}

export function Section({ title, desc, children, grid = true }: { title: string; desc?: string; children: ReactNode; grid?: boolean }) {
  return (
    <ComponentCard title={title} desc={desc}>
      {grid ? <div className="grid grid-cols-1 gap-5 md:grid-cols-2">{children}</div> : children}
    </ComponentCard>
  );
}

function Wrap({ id, label, hint, wide, children }: { id: string; label?: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cn(wide && "md:col-span-2")}>
      {label && (
        <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-400">
          {label}
        </label>
      )}
      {children}
      {hint && <p className="mt-1.5 text-theme-xs text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}

const fid = (name: string) => `f-${name.replace(/[^\w-]/g, "_")}`;

export function TextField({
  name,
  label,
  value,
  hint,
  type = "text",
  wide,
  placeholder,
  required,
}: {
  name: string;
  label?: string;
  value?: string | number | null;
  hint?: string;
  type?: string;
  wide?: boolean;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <Wrap id={fid(name)} label={label} hint={hint} wide={wide}>
      <input
        id={fid(name)}
        name={name}
        type={type}
        defaultValue={value ?? ""}
        placeholder={placeholder}
        required={required}
        autoComplete={type === "password" ? "new-password" : "off"}
        className={cn(controlClass, "h-11")}
      />
    </Wrap>
  );
}

export function TextAreaField({ name, label, value, hint, rows = 4, wide = true, mono }: { name: string; label?: string; value?: string | null; hint?: string; rows?: number; wide?: boolean; mono?: boolean }) {
  return (
    <Wrap id={fid(name)} label={label} hint={hint} wide={wide}>
      <textarea id={fid(name)} name={name} rows={rows} defaultValue={value ?? ""} className={cn(controlClass, mono && "font-mono text-theme-xs")} />
    </Wrap>
  );
}

export function SelectField({ name, label, value, options, hint, wide }: { name: string; label?: string; value?: string | number | null; options: Opt[]; hint?: string; wide?: boolean }) {
  return (
    <Wrap id={fid(name)} label={label} hint={hint} wide={wide}>
      <select id={fid(name)} name={name} defaultValue={value === null || value === undefined ? "" : String(value)} className={cn(controlClass, "h-11 py-0")}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled} className="dark:bg-gray-900">
            {o.label}
          </option>
        ))}
      </select>
    </Wrap>
  );
}

export function RadioField({ name, label, value, options, hint, wide }: { name: string; label?: string; value?: string | null; options: Opt[]; hint?: string; wide?: boolean }) {
  return (
    <Wrap id={fid(name)} label={label} hint={hint} wide={wide}>
      <div className="flex flex-wrap gap-4 pt-2">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input type="radio" name={name} value={o.value} defaultChecked={value === o.value} className="h-4 w-4 accent-brand-500" />
            {o.label}
          </label>
        ))}
      </div>
    </Wrap>
  );
}

export function CheckboxField({ name, label, checked, value = "1", hint, wide }: { name: string; label: string; checked?: boolean; value?: string; hint?: string; wide?: boolean }) {
  return (
    <Wrap id={fid(name)} hint={hint} wide={wide}>
      <label className="flex items-center gap-3 pt-2 text-sm text-gray-700 dark:text-gray-300">
        <input id={fid(name)} type="checkbox" name={name} value={value} defaultChecked={!!checked} className="h-4 w-4 accent-brand-500" />
        {label}
      </label>
    </Wrap>
  );
}

export function Hidden({ name, value }: { name: string; value: string | number | null | undefined }) {
  return <input type="hidden" name={name} value={value ?? ""} />;
}

export function InfoText({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn(wide && "md:col-span-2")}>
      <p className="mb-1.5 text-sm font-medium text-gray-700 dark:text-gray-400">{label}</p>
      <div className="text-sm text-gray-800 dark:text-white/90">{children}</div>
    </div>
  );
}

/** Avviso informativo (stile warning TailAdmin). */
export function Callout({ tone = "warning", children }: { tone?: "warning" | "info" | "error" | "success"; children: ReactNode }) {
  const styles = {
    warning: "border-warning-500 bg-warning-50 text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/15 dark:text-orange-400",
    info: "border-blue-light-500 bg-blue-light-50 text-blue-light-700 dark:border-blue-light-500/30 dark:bg-blue-light-500/15 dark:text-blue-light-400",
    error: "border-error-500 bg-error-50 text-error-700 dark:border-error-500/30 dark:bg-error-500/15 dark:text-error-400",
    success: "border-success-500 bg-success-50 text-success-700 dark:border-success-500/30 dark:bg-success-500/15 dark:text-success-400",
  }[tone];
  return <div className={cn("rounded-lg border p-4 text-sm", styles)}>{children}</div>;
}
