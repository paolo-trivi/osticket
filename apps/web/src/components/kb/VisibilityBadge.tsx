import Badge from "@/components/ui/badge/Badge";

export interface VisibilityLabels {
  featured: string;
  public: string;
  internal: string;
}

/** Visibilità di FAQ e categorie (VISIBILITY_FEATURED / PUBLIC / PRIVATE). */
export default function VisibilityBadge({ visibility, labels, size = "sm" }: { visibility: 0 | 1 | 2; labels: VisibilityLabels; size?: "sm" | "md" }) {
  const color = visibility === 2 ? "primary" : visibility === 1 ? "success" : "light";
  const label = visibility === 2 ? labels.featured : visibility === 1 ? labels.public : labels.internal;
  return (
    <Badge color={color} size={size}>
      {label}
    </Badge>
  );
}
