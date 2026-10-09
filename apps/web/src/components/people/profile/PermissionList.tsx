import { useTranslations } from "next-intl";

import Badge from "@/components/ui/badge/Badge";
import { ALL_PERMISSIONS } from "@/server/domain/admin/role";

/** Chiave di traduzione di un permesso: next-intl usa il punto per annidare, quindi "ticket.close" → "ticket_close". */
const msgKey = (perm: string) => perm.replace(/\./g, "_");

/**
 * Permessi con etichette leggibili ("Ticket: chiudere"), nell'ordine e nei gruppi di
 * RolePermission::allPermissions (ALL_PERMISSIONS). Le chiavi sconosciute restano visibili così come sono.
 */
export default function PermissionList({ perms, color }: { perms: readonly string[]; color: "success" | "info" }) {
  const t = useTranslations("permissions");
  const granted = new Set(perms);
  const known = ALL_PERMISSIONS.filter((p) => granted.has(p.key));
  const unknown = perms.filter((p) => !ALL_PERMISSIONS.some((d) => d.key === p));
  return (
    <div className="flex flex-wrap gap-2">
      {known.map((p) => (
        <Badge key={p.key} size="sm" color={color}>
          <span title={p.key}>
            {t(`groups.${p.group}`)}: {t.has(`items.${msgKey(p.key)}`) ? t(`items.${msgKey(p.key)}`) : p.title}
          </span>
        </Badge>
      ))}
      {unknown.map((p) => (
        <Badge key={p} size="sm" color={color}>
          {p}
        </Badge>
      ))}
    </div>
  );
}
