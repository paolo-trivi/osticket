import "server-only";

import { getTranslations } from "next-intl/server";

import type { FormSection } from "@/lib/admin/form-schema";
import { db } from "@/server/db";
import { phpJsonDecode } from "@/server/format/php-json";
import { ALL_PERMISSIONS } from "@/server/domain/admin/role";

import { permLabel } from "./perm-label";

/** Sezioni del form ruolo (include/staff/role.inc.php): permessi non "primari" per gruppo. */
export async function roleSections(roleId: number | null): Promise<FormSection[] | null> {
  const t = await getTranslations("admRoles");
  const role = roleId ? await db().selectFrom("role").selectAll().where("id", "=", roleId).executeTakeFirst() : null;
  if (roleId && !role) return null;
  const perms = phpJsonDecode<Record<string, unknown>>(role?.permissions ?? "", {});
  const selected = Object.entries(perms ?? {}).filter(([, v]) => !!v).map(([k]) => k);
  const roleGroups = [...new Set(ALL_PERMISSIONS.filter((p) => !p.primary).map((p) => p.group))];
  return [
    {
      title: t("sections.role"),
      fields: [
        { kind: "hidden", name: "do", value: roleId ? "update" : "add" },
        { kind: "hidden", name: "id", value: roleId ? String(roleId) : "" },
        { kind: "text", name: "name", label: t("name"), value: role?.name ?? "", required: true },
        { kind: "textarea", name: "notes", label: t("notes"), value: role?.notes ?? "", rows: 3, wide: true },
      ],
    },
    {
      title: t("sections.perms"),
      fields: [
        {
          kind: "checkboxes",
          name: "perms[]",
          label: t("perms"),
          wide: true,
          values: selected,
          options: [],
          groups: roleGroups.map((g) => ({
            title: t.has(`groups.${g}`) ? t(`groups.${g}`) : g,
            options: ALL_PERMISSIONS.filter((p) => !p.primary && p.group === g).map((p) => ({ value: p.key, label: permLabel(t, p) })),
          })),
        },
      ],
    },
  ];
}
