import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getCashSettings, setCashSettings, type CashSettings } from "@/api/stores";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/MoneyInput";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/errors";

const MONEY_FIELDS: { key: keyof CashSettings; label: string }[] = [
  { key: "opening_cash_fixed", label: "Base fija de apertura" },
  { key: "cash_reserve_default", label: "Reserva por defecto" },
  { key: "tolerance_unknown_cause", label: "Tolerancia sin causa identificada" },
  { key: "tolerance_identified_cause", label: "Tolerancia con causa identificada" },
  { key: "critical_difference", label: "Diferencia crítica" },
  { key: "cash_pickup_threshold", label: "Umbral de retiro" },
  { key: "petty_cash_limit", label: "Límite de gasto menor" },
];

/** `GET/PUT /admin/stores/{id}/cash-settings`. */
export function CashSection({ storeId }: { storeId: number | null }): React.JSX.Element {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["admin-cash-settings", storeId],
    queryFn: () => getCashSettings(storeId as number),
    enabled: storeId !== null,
  });
  const [values, setValues] = useState<CashSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.data) setValues(query.data);
  }, [query.data]);

  if (storeId === null) {
    return <EmptyState title="Elegí una sede" description="Creá una sede en la pestaña Sedes primero." />;
  }
  if (query.isLoading || !values) {
    return <Skeleton className="h-64 w-full max-w-md" />;
  }
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo cargar la configuración de caja"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!values) return;
    setSaving(true);
    setError(null);
    try {
      await setCashSettings(storeId as number, values);
      await queryClient.invalidateQueries({ queryKey: ["admin-cash-settings", storeId] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="max-w-md space-y-4" onSubmit={handleSubmit}>
      {MONEY_FIELDS.map(({ key, label }) => (
        <div key={key} className="space-y-1.5">
          <Label htmlFor={`cash-${key}`}>{label}</Label>
          <MoneyInput
            id={`cash-${key}`}
            value={values[key] as number}
            onChange={(next) => setValues((v) => (v ? { ...v, [key]: next ?? 0 } : v))}
          />
        </div>
      ))}
      <div className="space-y-1.5">
        <Label htmlFor="cash-streak">Turnos seguidos con diferencia para alertar</Label>
        <Input
          id="cash-streak"
          type="number"
          min={1}
          className="h-11"
          value={values.streak_alert_shifts}
          onChange={(e) => setValues((v) => (v ? { ...v, streak_alert_shifts: Number(e.target.value) } : v))}
        />
      </div>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={values.photo_required_on_close}
            onCheckedChange={(c) => setValues((v) => (v ? { ...v, photo_required_on_close: c === true } : v))}
          />
          Foto obligatoria al cerrar turno
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={values.photo_required_on_pickup}
            onCheckedChange={(c) => setValues((v) => (v ? { ...v, photo_required_on_pickup: c === true } : v))}
          />
          Foto obligatoria en retiros
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={saving}>
        {saving ? "Guardando…" : "Guardar"}
      </Button>
    </form>
  );
}
