import { Inbox, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: { label: string; onClick: () => void };
  /** `"alert"` para el estado de error (lo mismo que un 4xx legible). */
  role?: "status" | "alert";
}

/**
 * Un solo componente para "sin datos" y para "algo falló al cargar" — toda
 * lista tiene que decir explícitamente cuál de las dos es (SPEC-NEGOCIO
 * § 9.3: "«sin datos» se dice, no se dibuja como cero").
 */
export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
  role = "status",
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      role={role}
      className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center"
    >
      <Icon className="size-8 text-muted-foreground" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? (
        <Button type="button" variant="outline" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
