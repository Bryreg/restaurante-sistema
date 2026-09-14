import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";

import { listNotifications, markNotificationRead } from "@/api/notifications";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";

/** Campana: sondea `GET /admin/notifications` y marca leídas al abrir. */
export function NotificationBell({ storeId }: { storeId: number | null }): React.JSX.Element {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["admin-notifications", storeId],
    queryFn: () => listNotifications({ storeId }),
    refetchInterval: 30_000,
  });

  const notifications = data ?? [];
  const unreadCount = notifications.filter((n) => n.read_at === null).length;

  async function handleMarkRead(id: number) {
    await markNotificationRead(id);
    await queryClient.invalidateQueries({ queryKey: ["admin-notifications", storeId] });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="relative"
            aria-label={unreadCount > 0 ? `Notificaciones, ${unreadCount} sin leer` : "Notificaciones"}
          />
        }
      >
        <Bell className="size-5" aria-hidden="true" />
        {unreadCount > 0 ? (
          <Badge
            variant="destructive"
            className="absolute -right-1 -top-1 h-5 min-w-5 justify-center px-1 text-[11px]"
            aria-hidden="true"
          >
            {unreadCount}
          </Badge>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Notificaciones</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {isLoading ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">Cargando…</div>
        ) : isError ? (
          <div className="px-2 py-3 text-sm text-destructive">{errorMessage(error)}</div>
        ) : notifications.length === 0 ? (
          <div className="px-2 py-3 text-sm text-muted-foreground">Sin notificaciones.</div>
        ) : (
          notifications.slice(0, 8).map((n) => (
            <DropdownMenuItem
              key={n.id}
              className="flex flex-col items-start gap-0.5 whitespace-normal"
              onSelect={() => {
                if (n.read_at === null) void handleMarkRead(n.id);
              }}
            >
              <span className="text-sm font-medium">{n.title}</span>
              <span className="text-xs text-muted-foreground">{n.body}</span>
              <span className="text-xs text-muted-foreground">{formatInstant(n.created_at)}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
