"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";

import { ThemeSchema, type ThemeSettings } from "@/lib/theme/schema";
import { touchStaffSession } from "@/server/auth/staff-auth";
import { canWrite, isReadOnlyError } from "@/server/system/write-mode";
import { saveTheme } from "@/server/theme/theme";

import { requireAdmin } from "../guard";

export type SaveThemeState = {
  status: "idle" | "saved" | "error";
  message?: string;
};

/** Salvataggio del tema (scrittura "admin"): in sola lettura `message: "read_only"`. */
export async function saveThemeAction(settings: ThemeSettings): Promise<SaveThemeState> {
  const agent = await requireAdmin(await getLocale());
  const parsed = ThemeSchema.safeParse(settings);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.path.join(".") };
  if (!(await canWrite("admin"))) return { status: "error", message: "read_only" };
  try {
    await saveTheme(parsed.data, agent.id);
  } catch (err) {
    if (isReadOnlyError(err)) return { status: "error", message: "read_only" };
    throw err;
  }
  await touchStaffSession();
  // il tema è letto dal layout radice: ricarica tutte le pagine
  revalidatePath("/", "layout");
  return { status: "saved" };
}
