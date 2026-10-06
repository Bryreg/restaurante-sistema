import { useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { markNotificationRead } from "@/api/notifications";
import { railItemClass } from "@/components/admin/RailItem";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

import { avisoHref } from "./avisos";
import { useNotificaciones } from "./useAvisos";

export interface NotificationBellProps {
  storeId: number | null;
  /**
   * `"icon"` es la campana cuadrada de siempre. `"rail"` es la fila del pie
   * de la lateral del admin: la campana bajó ahí cuando la barra superior
   * dejó de existir (`docs/PATRONES-ADMIN.md` § 1), que es lo que la propia
   * pantalla de Notificaciones ya decía —«la campana de la lateral»—.
   * `"barra"` es el botón de la barra superior del handoff (`AdminTop`):
   * campana, la palabra «Avisos» y el recuento en rojo.
   */
  variant?: "icon" | "rail" | "barra";
  /** En el cajón del móvil la fila necesita el objetivo táctil. */
  touch?: boolean;
}

/**
 * Campana: sondea `GET /admin/notifications` y **marca leídas al abrir** las
 * que muestra. Leído no es resuelto (0042): el aviso deja de contar como
 * nuevo en el recuento, pero sigue en «Requiere tu atención» de Hoy hasta
 * que alguien lo resuelve allá o la condición que lo disparó se apaga.
 */
export function NotificationBell({
  storeId,
  variant = "icon",
  touch = false,
}: NotificationBellProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useNotificaciones(storeId);

  const notifications = data ?? [];
  const unreadCount = notifications.filter((n) => n.read_at === null).length;

  async function handleMarkRead(id: number) {
    await markNotificationRead(id);
    await queryClient.invalidateQueries({ queryKey: ["admin-notifications", storeId] });
  }

  const shown = notifications.slice(0, 8);

  /** Al abrir: las que se ven quedan leídas (no resueltas). */
  async function handleOpen() {
    const unread = shown.filter((n) => n.read_at === null);
    if (unread.length === 0) return;
    await Promise.allSettled(unread.map((n) => markNotificationRead(n.id)));
    await queryClient.invalidateQueries({ queryKey: ["admin-notifications", storeId] });
  }

  const trigger =
    variant === "barra" ? (
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            // «Burbujas»: campana de 40 × 40 sobre el pozo, con punto rojo si
            // hay avisos sin leer; el recuento va en el nombre accesible.
            className="relative size-10 min-h-0 rounded-xl bg-muted p-0 font-normal text-foreground hover:bg-accent"
            // El nombre empieza por lo que se ve («Avisos»): quien dicta por
            // voz nombra lo que lee (WCAG 2.5.3).
            aria-label={unreadCount > 0 ? `Avisos, ${unreadCount} sin leer` : "Avisos"}
          />
        }
      >
        <Bell className="size-[18px] shrink-0" aria-hidden="true" />
        <span className="sr-only">Avisos</span>
        {unreadCount > 0 ? (
          <span
            aria-hidden="true"
            className="absolute top-2 right-2 size-2 rounded-full bg-destructive ring-2 ring-muted"
          />
        ) : null}
      </DropdownMenuTrigger>
    ) : null;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void handleOpen();
      }}
    >
      {trigger ?? (
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size={variant === "rail" ? "default" : "icon"}
            className={variant === "rail" ? railItemClass({ touch }) : "relative"}
            aria-label={unreadCount > 0 ? `Notificaciones, ${unreadCount} sin leer` : "Notificaciones"}
          />
        }
      >
        <Bell className={variant === "rail" ? "size-4 shrink-0" : "size-5"} aria-hidden="true" />
        {variant === "rail" ? <span className="min-w-0 flex-1 truncate">Notificaciones</span> : null}
        {unreadCount > 0 ? (
          <Badge
            variant="destructive"
            className={
              variant === "rail"
                ? "h-5 min-w-5 shrink-0 justify-center px-1 text-[11px]"
                : "absolute -right-1 -top-1 h-5 min-w-5 justify-center px-1 text-[11px]"
            }
            aria-hidden="true"
          >
            {unreadCount}
          </Badge>
        ) : null}
      </DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="end" className="w-80">
        {/* `DropdownMenuLabel` es un `Menu.GroupLabel` de Base UI: fuera de un
            `Menu.Group` lanza «MenuGroupContext is missing» y tumbaba la app
            entera al abrir la campana. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Notificaciones</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {isLoading ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">Cargando…</div>
        ) : isError ? (
          <div className="px-2 py-3 text-sm text-destructive">{errorMessage(error)}</div>
        ) : notifications.length === 0 ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">Sin notificaciones.</div>
        ) : (
          shown.map((n) => (
            <DropdownMenuItem
              key={n.id}
              className={cn("flex flex-col items-start gap-0.5 whitespace-normal", n.read_at === null && "font-medium")}
              // Base UI no tiene `onSelect` (eso es de Radix): el aviso nunca se marcaba leído.
              // Tocarlo, además, abre su vista: detalle, a dónde se resuelve y su rastro.
              onClick={() => {
                if (n.read_at === null) void handleMarkRead(n.id);
                void navigate(avisoHref(n.id));
              }}
            >
              <span className="text-sm font-medium">{n.title}</span>
              <span className="text-xs text-muted-foreground">{n.body}</span>
              <span className="text-xs text-muted-foreground">
                {formatInstant(n.created_at)}
                {n.resolved_at ? ` · Resuelto${n.resolved_by_name ? ` por ${n.resolved_by_name}` : ""}` : ""}
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
