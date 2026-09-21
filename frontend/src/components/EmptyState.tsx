import { CircleCheck, CloudOff, FilterX, Inbox, Package, Power, type LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * **El motivo decide la acción** (`docs/PATRONES-ADMIN.md` § 13). Once de las
 * veinticuatro pantallas del admin dicen hoy «No hay datos» y se callan; el
 * molde es siempre el mismo —ícono · qué no hay · por qué · la acción que lo
 * arregla— y lo único que cambia entre un caso y otro es **por qué está
 * vacío**, que es justamente lo que decide qué botón corresponde.
 *
 * Es OPCIONAL y aditivo: sin `reason`, este componente se comporta exactamente
 * como antes de la ola 1 (ícono `Inbox`, tinta apagada, acción secundaria),
 * que es lo que los usos ya escritos esperan. Los envoltorios tipados de cada
 * motivo viven en `@/components/admin` (`FilterEmptyState`,
 * `FeatureOffEmptyState`, `DependencyEmptyState`, `AllClearEmptyState`): son
 * los que obligan a nombrar el filtro, la función o la dependencia culpable.
 */
export type EmptyStateReason = "filter" | "feature-off" | "dependency" | "all-clear" | "error";

/**
 * Una salida. `to` navega (el motivo que lleva a OTRA pantalla: encender la
 * función, crear lo que falta); `onClick` actúa sin moverse (quitar el filtro,
 * reintentar). Se puede dar cualquiera de los dos.
 */
export interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  /** Destino de router. Sólo se dibuja como enlace si se pasa. */
  to?: string;
}

export interface EmptyStateProps {
  title: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  action?: EmptyStateAction;
  /** Una segunda salida, secundaria: «Copiar el detalle», «Volver a Hoy». */
  secondaryAction?: EmptyStateAction;
  /** `"alert"` para el estado de error (lo mismo que un 4xx legible). */
  role?: "status" | "alert";
  /** Por qué está vacío. Elige ícono, tinta y énfasis de la acción. */
  reason?: EmptyStateReason;
  /**
   * Más salidas, para el motivo que ofrece varias —un vacío por filtro con
   * tres filtros puestos nombra los tres—. Se dibujan en la misma fila que
   * `action`.
   */
  children?: React.ReactNode;
}

/** El ícono por motivo. Sin motivo, el de siempre. */
const REASON_ICON: Record<EmptyStateReason, LucideIcon> = {
  filter: FilterX,
  "feature-off": Power,
  dependency: Package,
  "all-clear": CircleCheck,
  error: CloudOff,
};

/**
 * La tinta del ícono. Verde y rojo son ESTADO (`docs/DISENO.md` § La regla del
 * color): un «todo al día» es una noticia buena y un error es un problema, y
 * ninguno de los dos es un botón.
 */
const REASON_ICON_TONE: Record<EmptyStateReason, string> = {
  filter: "text-muted-foreground",
  "feature-off": "text-muted-foreground",
  dependency: "text-muted-foreground",
  "all-clear": "text-success",
  error: "text-destructive",
};

/**
 * El énfasis de la acción. Los motivos que llevan a otra pantalla —encender la
 * función, crear lo que falta, reintentar— proponen ir: botón azul lleno. Los
 * que actúan acá mismo —quitar un filtro— siguen siendo secundarios, que es
 * además el comportamiento de todos los usos anteriores a la ola 1.
 */
const REASON_EMPHASIS: Record<EmptyStateReason, "default" | "outline"> = {
  filter: "outline",
  "feature-off": "default",
  dependency: "default",
  "all-clear": "outline",
  error: "default",
};

function ActionButton({
  action,
  variant,
}: {
  action: EmptyStateAction;
  variant: "default" | "outline" | "ghost";
}): React.JSX.Element {
  if (action.to) {
    return (
      <Button variant={variant} render={<Link to={action.to} />}>
        {action.label}
      </Button>
    );
  }
  return (
    <Button type="button" variant={variant} onClick={action.onClick}>
      {action.label}
    </Button>
  );
}

/**
 * Un solo componente para "sin datos" y para "algo falló al cargar" — toda
 * lista tiene que decir explícitamente cuál de las dos es (SPEC-NEGOCIO
 * § 9.3: "«sin datos» se dice, no se dibuja como cero").
 *
 * Con `reason` además dice **por qué**, y el por qué decide la acción
 * (`docs/PATRONES-ADMIN.md` § 13). Sin `reason` nada cambia: los usos que ya
 * existían siguen dibujando lo mismo.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  secondaryAction,
  role,
  reason,
  children,
}: EmptyStateProps): React.JSX.Element {
  const Icon = icon ?? (reason ? REASON_ICON[reason] : Inbox);
  const iconTone = reason ? REASON_ICON_TONE[reason] : "text-muted-foreground";
  const emphasis = reason ? REASON_EMPHASIS[reason] : "outline";
  const resolvedRole = role ?? (reason === "error" ? "alert" : "status");
  const hasActions = Boolean(action ?? secondaryAction ?? children);

  return (
    <div
      role={resolvedRole}
      className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center"
    >
      <Icon className={cn("size-8", iconTone)} aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {hasActions ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {action ? <ActionButton action={action} variant={emphasis} /> : null}
          {secondaryAction ? <ActionButton action={secondaryAction} variant="ghost" /> : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}
