import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useStoreSelection } from "@/app/storeContext";
import {
  getNotificationRules,
  listNotifications,
  markNotificationRead,
  setNotificationRules,
  type NotificationLevel,
  type NotificationRule,
} from "@/api/notifications";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";

const TYPE_LABEL: Record<string, string> = {
  shift_stale: "Turno abandonado",
  cash_difference: "Diferencia de caja",
  cash_difference_critical: "Diferencia crítica",
  difference_streak: "Racha de diferencias",
  cash_over_threshold: "Efectivo sobre el umbral",
  pin_locked: "PIN bloqueado",
  product_unavailable: "Producto agotado",
};

const LEVEL_LABEL: Record<NotificationLevel, string> = {
  info: "Informativo",
  warning: "Alerta",
  critical: "Crítico",
};

function NotificationsList() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["admin-notifications", "all"], queryFn: () => listNotifications() });

  async function handleMarkRead(id: number) {
    await markNotificationRead(id);
    await queryClient.invalidateQueries({ queryKey: ["admin-notifications"] });
  }

  const notifications = query.data ?? [];

  if (query.isLoading) return <Skeleton className="h-32 w-full" />;
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar las notificaciones"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }
  if (notifications.length === 0) {
    return <EmptyState title="Sin notificaciones" />;
  }

  return (
    <div className="space-y-2">
      {notifications.map((n) => (
        <div key={n.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge variant={n.level === "critical" ? "destructive" : "secondary"}>{LEVEL_LABEL[n.level]}</Badge>
              <p className="text-sm font-medium">{n.title}</p>
            </div>
            <p className="text-sm text-muted-foreground">{n.body}</p>
            <p className="text-xs text-muted-foreground">{formatInstant(n.created_at)}</p>
          </div>
          {n.read_at === null ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void handleMarkRead(n.id)}>
              Marcar leída
            </Button>
          ) : (
            <Badge variant="outline">Leída</Badge>
          )}
        </div>
      ))}
    </div>
  );
}

function NotificationRules({ storeId }: { storeId: number }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["admin-notification-rules", storeId],
    queryFn: () => getNotificationRules(storeId),
  });
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.data) setRules(query.data);
  }, [query.data]);

  if (query.isLoading) return <Skeleton className="h-40 w-full" />;
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar las reglas"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  function updateRule(type: string, patch: Partial<NotificationRule>) {
    setRules((prev) => prev.map((r) => (r.type === type ? { ...r, ...patch } : r)));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await setNotificationRules(storeId, rules);
      await queryClient.invalidateQueries({ queryKey: ["admin-notification-rules", storeId] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tipo</TableHead>
              <TableHead>Activa</TableHead>
              <TableHead>Umbral</TableHead>
              <TableHead>Nivel</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((rule) => (
              <TableRow key={rule.type}>
                <TableCell>{TYPE_LABEL[rule.type] ?? rule.type}</TableCell>
                <TableCell>
                  <Switch
                    checked={rule.enabled}
                    aria-label={`${rule.enabled ? "Apagar" : "Encender"} alerta ${TYPE_LABEL[rule.type] ?? rule.type}`}
                    onCheckedChange={(next) => updateRule(rule.type, { enabled: next })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    className="h-9 w-28"
                    aria-label={`Umbral de ${TYPE_LABEL[rule.type] ?? rule.type}`}
                    value={rule.threshold ?? ""}
                    onChange={(e) =>
                      updateRule(rule.type, { threshold: e.target.value === "" ? null : Number(e.target.value) })
                    }
                  />
                </TableCell>
                <TableCell>
                  <Select
                    value={rule.level}
                    onValueChange={(v) => updateRule(rule.type, { level: v as NotificationLevel })}
                  >
                    <SelectTrigger className="h-9 w-36" aria-label={`Nivel de ${TYPE_LABEL[rule.type] ?? rule.type}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="info">Informativo</SelectItem>
                      <SelectItem value="warning">Alerta</SelectItem>
                      <SelectItem value="critical">Crítico</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="button" onClick={() => void handleSave()} disabled={saving}>
        {saving ? "Guardando…" : "Guardar reglas"}
      </Button>
    </div>
  );
}

/** Admin → Notificaciones: campana + reglas por sede. */
export default function NotificationsPage(): React.JSX.Element {
  const { stores, activeStoreId } = useStoreSelection();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold">Notificaciones</h1>
        <p className="text-sm text-muted-foreground">Lo que avisó el sistema y cuándo debe avisar.</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Recientes</h2>
        <NotificationsList />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Reglas por sede</h2>
        {stores.length === 0 ? (
          <EmptyState title="Creá una sede primero" description="Las reglas se configuran por sede." />
        ) : activeStoreId === null ? (
          <p className="text-sm text-muted-foreground">Elegí una sede para ver sus reglas.</p>
        ) : (
          <NotificationRules storeId={activeStoreId} />
        )}
      </section>
    </div>
  );
}
