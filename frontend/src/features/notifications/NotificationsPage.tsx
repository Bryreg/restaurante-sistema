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
import {
  DenseTable,
  DenseTableBar,
  FormSection,
  PageHeader,
  SaveBar,
  TimeAgo,
  type DenseColumn,
  type PendingChange,
  type RowStatus,
} from "@/components/admin";
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

/** Qué gobierna cada regla, en palabras: a quién le llega y de dónde sale. */
const TYPE_HELP: Record<string, string> = {
  shift_stale: "Un turno que pasó su hora de corte y sigue abierto: el salón sigue vendiendo sobre un turno de ayer.",
  cash_difference: "El cierre no cuadró. El umbral de esta regla no es el del cierre: ése vive en Ajustes › Caja.",
  cash_difference_critical: "La diferencia pasó la crítica de Ajustes › Caja y el turno queda marcado para revisión.",
  difference_streak: "Varios cierres seguidos con diferencia, aunque cada uno esté dentro de tolerancia.",
  cash_over_threshold: "Hay más efectivo en el cajón que el umbral de retiro de Ajustes › Caja.",
  pin_locked: "Alguien erró el PIN demasiadas veces y quedó bloqueado: no puede trabajar hasta que se destrabe.",
  product_unavailable: "Un plato se marcó agotado en el salón y dejó de venderse.",
};

/** El nivel es **estado**, no acción: dice qué tan grave, nunca invita a tocar. */
const LEVEL_STATUS: Record<NotificationLevel, RowStatus> = {
  info: "none",
  warning: "warning",
  critical: "critical",
};

function NotificationsList() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["admin-notifications", "all"], queryFn: () => listNotifications() });

  async function handleMarkRead(id: number) {
    await markNotificationRead(id);
    await queryClient.invalidateQueries({ queryKey: ["admin-notifications"] });
  }

  const notifications = query.data ?? [];
  const sinLeer = notifications.filter((n) => n.read_at === null).length;

  if (query.isLoading) return <Skeleton className="h-32 w-full" />;
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        reason="error"
        title="No se pudieron cargar las notificaciones"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  const columns: readonly DenseColumn<(typeof notifications)[number]>[] = [
    {
      key: "level",
      header: "Nivel",
      widthPx: 104,
      cell: (n) => (
        <Badge variant={n.level === "critical" ? "destructive" : "secondary"}>{LEVEL_LABEL[n.level]}</Badge>
      ),
    },
    { key: "title", header: "Aviso", kind: "name", cell: (n) => n.title },
    { key: "body", header: "Qué pasó", kind: "secondary", cell: (n) => n.body },
    {
      key: "at",
      header: "Cuándo",
      kind: "secondary",
      widthPx: 100,
      cell: (n) => <TimeAgo iso={n.created_at} />,
      cellTitle: (n) => formatInstant(n.created_at),
    },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (n) =>
        n.read_at === null ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void handleMarkRead(n.id)}>
            Marcar leída
          </Button>
        ) : (
          <Badge variant="outline">Leída</Badge>
        ),
    },
  ];

  return (
    <DenseTable
      caption="Notificaciones recientes del sistema"
      columns={columns}
      rows={notifications}
      rowKey={(n) => String(n.id)}
      rowStatus={(n) => (n.read_at === null ? LEVEL_STATUS[n.level] : "none")}
      rowInactive={(n) => n.read_at !== null}
      maxBodyHeightPx={420}
      bar={
        <DenseTableBar
          shown={notifications.length}
          total={notifications.length}
          noun="avisos"
          hidden={sinLeer > 0 ? `${sinLeer} sin leer` : "ninguno sin leer"}
        />
      }
      legend={[
        {
          term: "Leída no es resuelta",
          meaning:
            "marcar leída apaga el contador de la campana; lo que el aviso señala sigue ahí hasta que alguien lo arregle.",
        },
        {
          term: "El nivel sale de la regla",
          meaning: "el mismo hecho puede llegar como informativo o como crítico según cómo esté la regla de su sede.",
        },
      ]}
      empty={<EmptyState title="Sin notificaciones" description="El sistema todavía no tuvo nada que avisar." />}
    />
  );
}

function cambiosDeReglas(guardadas: NotificationRule[], actuales: NotificationRule[]): PendingChange[] {
  const cambios: PendingChange[] = [];
  for (const rule of actuales) {
    const antes = guardadas.find((r) => r.type === rule.type);
    if (!antes) continue;
    const nombre = TYPE_LABEL[rule.type] ?? rule.type;
    if (antes.enabled !== rule.enabled) {
      cambios.push({
        field: `${nombre} · Activa`,
        from: antes.enabled ? "Sí avisa" : "No avisa",
        to: rule.enabled ? "Sí avisa" : "No avisa",
      });
    }
    if ((antes.threshold ?? null) !== (rule.threshold ?? null)) {
      cambios.push({
        field: `${nombre} · Umbral`,
        from: antes.threshold === null || antes.threshold === undefined ? "—" : String(antes.threshold),
        to: rule.threshold === null || rule.threshold === undefined ? "—" : String(rule.threshold),
      });
    }
    if (antes.level !== rule.level) {
      cambios.push({
        field: `${nombre} · Nivel`,
        from: LEVEL_LABEL[antes.level],
        to: LEVEL_LABEL[rule.level],
      });
    }
  }
  return cambios;
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
        reason="error"
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

  const guardadas = query.data ?? [];
  const cambios = cambiosDeReglas(guardadas, rules);
  const apagadas = rules.filter((r) => !r.enabled).length;

  const columns: readonly DenseColumn<NotificationRule>[] = [
    {
      key: "type",
      header: "Aviso",
      kind: "name",
      cell: (rule) => TYPE_LABEL[rule.type] ?? rule.type,
    },
    {
      key: "what",
      header: "Qué lo dispara",
      kind: "secondary",
      cell: (rule) => TYPE_HELP[rule.type] ?? "—",
    },
    {
      key: "enabled",
      header: "Activa",
      widthPx: 64,
      cell: (rule) => (
        <Switch
          checked={rule.enabled}
          aria-label={`${rule.enabled ? "Apagar" : "Encender"} alerta ${TYPE_LABEL[rule.type] ?? rule.type}`}
          onCheckedChange={(next) => updateRule(rule.type, { enabled: next })}
        />
      ),
    },
    {
      key: "threshold",
      header: "Umbral",
      widthPx: 110,
      cell: (rule) => (
        <Input
          type="number"
          className="h-8 w-24"
          aria-label={`Umbral de ${TYPE_LABEL[rule.type] ?? rule.type}`}
          value={rule.threshold ?? ""}
          onChange={(e) =>
            updateRule(rule.type, { threshold: e.target.value === "" ? null : Number(e.target.value) })
          }
        />
      ),
    },
    {
      key: "level",
      header: "Nivel",
      widthPx: 150,
      cell: (rule) => (
        <Select value={rule.level} onValueChange={(v) => updateRule(rule.type, { level: v as NotificationLevel })}>
          <SelectTrigger className="h-8 w-36" aria-label={`Nivel de ${TYPE_LABEL[rule.type] ?? rule.type}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="info">Informativo</SelectItem>
            <SelectItem value="warning">Alerta</SelectItem>
            <SelectItem value="critical">Crítico</SelectItem>
          </SelectContent>
        </Select>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <FormSection
        title="Cuándo tiene que avisar el sistema"
        columns="one"
        governs="Una regla por tipo de aviso, para esta sede. Deciden qué llega a la campana del admin y con qué gravedad."
        reading={
          <>
            De <b className="font-bold text-foreground tabular-nums">{rules.length}</b> avisos posibles,{" "}
            <b className="font-bold text-foreground tabular-nums">{rules.length - apagadas}</b> están encendidos
            para esta sede. Los apagados no se pierden: <b className="font-bold text-foreground">no avisan</b>, y
            el hecho igual queda en Historial y en las pantallas donde se ve.
          </>
        }
        doesNotDo={
          <>
            Apagar un aviso <b className="font-bold text-foreground">no cambia ninguna regla del negocio</b>: el
            cierre sigue pidiendo causa y el turno abandonado sigue siendo un turno abandonado. Lo único que
            cambia es a quién se le cuenta.
          </>
        }
      >
        <DenseTable
          caption="Reglas de notificación de esta sede"
          columns={columns}
          rows={rules}
          rowKey={(rule) => rule.type}
          rowStatus={(rule) => (rule.enabled ? LEVEL_STATUS[rule.level] : "none")}
          rowInactive={(rule) => !rule.enabled}
          bar={
            <DenseTableBar
              shown={rules.length}
              total={rules.length}
              noun="reglas"
              hidden={apagadas > 0 ? `${apagadas} apagadas` : "ninguna apagada"}
            />
          }
          legend={[
            {
              term: "Umbral vacío",
              meaning: "el aviso no usa umbral, o usa el de Ajustes › Caja. Vacío no es cero.",
            },
            {
              term: "Por sede",
              meaning: "estas reglas valen para la sede activa; otra sede puede tener las suyas.",
            },
          ]}
          empty={<EmptyState title="Sin reglas para esta sede" description="El servidor todavía no creó las reglas por defecto." />}
        />
      </FormSection>

      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}

      <SaveBar
        sectionName="Reglas por sede"
        changes={cambios}
        saving={saving}
        onSave={() => void handleSave()}
        onDiscard={() => setRules(guardadas)}
      />
    </div>
  );
}

/** Admin → Notificaciones: campana + reglas por sede. */
export default function NotificationsPage(): React.JSX.Element {
  const { stores, activeStoreId } = useStoreSelection();

  return (
    <div className="space-y-4">
      <PageHeader
        name="Notificaciones"
        question="¿Qué avisó el sistema, y qué tiene que avisar la próxima vez?"
        context={[
          { label: "La campana", value: "cada 30 s", title: "La campana de la lateral repregunta sola y cuenta las no leídas." },
          { label: "Las reglas", value: "por sede", title: "Cada sede decide qué le avisa y con qué gravedad." },
        ]}
      />

      <section className="space-y-2">
        <h2 className="text-xs font-bold tracking-wider uppercase">Recientes</h2>
        <NotificationsList />
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-bold tracking-wider uppercase">Reglas por sede</h2>
        {stores.length === 0 ? (
          <EmptyState
            title="Creá una sede primero"
            description="Las reglas se configuran por sede: sin sede no hay a quién avisarle."
            action={{ label: "Crear la primera sede", to: "/admin/settings" }}
          />
        ) : activeStoreId === null ? (
          <p className="text-sm text-muted-foreground">Elegí una sede para ver sus reglas.</p>
        ) : (
          <NotificationRules storeId={activeStoreId} />
        )}
      </section>
    </div>
  );
}
