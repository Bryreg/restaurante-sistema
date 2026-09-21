import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Scale, TriangleAlert } from "lucide-react";
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
import { formatCOP } from "@/lib/money";
import { cn } from "cn";

/**
 * Los montos que no son fronteras del arqueo. Las dos que SÍ lo son
 * —`tolerance_unknown_cause` y `critical_difference`— no están acá: viven en
 * su propia tarjeta, al lado de las tres bandas que definen, porque sueltas
 * en una lista plana de montos no se entiende que una es el techo de la otra.
 */
const MONEY_FIELDS: { key: keyof CashSettings; label: string }[] = [
  { key: "opening_cash_fixed", label: "Base fija de apertura" },
  { key: "cash_reserve_default", label: "Reserva por defecto" },
  { key: "cash_pickup_threshold", label: "Umbral de retiro" },
  { key: "petty_cash_limit", label: "Límite de gasto menor" },
];

/** Las tres bandas del arqueo, tal como las nombra `SPEC-NEGOCIO §3.2`. */
type Tono = "ok" | "warn" | "bad";

interface Banda {
  clave: string;
  rango: string;
  que: string;
  tono: Tono;
}

/**
 * Traduce las **dos fronteras** configuradas a las **tres bandas** que el
 * dueño necesita entender. No es una cuenta: es la misma comparación que hace
 * el servidor, escrita en palabras.
 *
 * Los límites se dicen con las dos cifras reales y con los operadores exactos
 * de `app/shifts/service.py::_evaluate_close` —`> tolerance_unknown_cause` y
 * `>= critical_difference`—, sin sumarle ni restarle un peso a ninguna. Eso
 * no es prolijidad: «hasta $20.000» y «desde $100.000» son los umbrales que
 * el servidor compara, y un «$99.999» calculado acá sería una cifra que el
 * backend nunca mandó (AGENTS.md § «una sola matemática, en el backend»).
 */
export function bandasDelArqueo(settings: Pick<CashSettings, "tolerance_unknown_cause" | "critical_difference">): Banda[] {
  const tolerancia = formatCOP(settings.tolerance_unknown_cause);
  const critica = formatCOP(settings.critical_difference);
  return [
    {
      clave: "libre",
      rango: `Hasta ${tolerancia}`,
      que: "Se cierra con cualquier causa, incluida «Sin identificar».",
      tono: "ok",
    },
    {
      clave: "identificada",
      rango: `Más de ${tolerancia} y menos de ${critica}`,
      que: "La causa debe ser identificada: «Sin identificar» deja de estar en la lista.",
      tono: "warn",
    },
    {
      clave: "critica",
      rango: `Desde ${critica}`,
      que: "Alerta crítica al administrador, y la causa también debe ser identificada.",
      tono: "bad",
    },
  ];
}

/**
 * Las dos fronteras ordenadas es lo que hace que existan tres bandas. Al
 * revés —o iguales— la del medio desaparece. El servidor lo rechaza con
 * `CRITICAL_BELOW_TOLERANCE`; acá se avisa antes de que el dueño guarde.
 */
export function fronterasInvertidas(
  settings: Pick<CashSettings, "tolerance_unknown_cause" | "critical_difference">,
): boolean {
  return settings.critical_difference <= settings.tolerance_unknown_cause;
}

const TONO_PUNTO: Record<Tono, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
};

const TONO_RANGO: Record<Tono, string> = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
};

/**
 * Las tres bandas, en el idioma de la spec. Verde, ámbar y rojo son **de
 * estado** (`docs/DISENO.md`): acá dicen en qué banda cae una diferencia, no
 * invitan a tocar nada. Lo único azul de la pantalla sigue siendo el botón.
 */
function BandasDelArqueo({ values }: { values: CashSettings }): React.JSX.Element {
  const invertidas = fronterasInvertidas(values);

  return (
    <div className="rounded-lg bg-muted/50 px-3 py-3">
      <h4 className="text-xs font-bold tracking-wider text-muted-foreground uppercase">
        Cómo queda el arqueo
      </h4>
      {invertidas ? (
        <p role="alert" className="mt-2 flex items-start gap-2 text-sm font-medium text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            La diferencia crítica tiene que ser mayor que la tolerancia sin causa identificada: subí la
            diferencia crítica o bajá la tolerancia. Así como están, la banda del medio no existe.
          </span>
        </p>
      ) : (
        <ul className="mt-2 space-y-2.5">
          {bandasDelArqueo(values).map((banda) => (
            <li key={banda.clave} className="flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONO_PUNTO[banda.tono])}
              />
              <span className="min-w-0 text-sm">
                <span className={cn("font-bold tabular-nums", TONO_RANGO[banda.tono])}>{banda.rango}</span>
                <span className="block text-xs leading-relaxed text-muted-foreground">{banda.que}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* La spec lo dice y la pantalla no lo decía en ningún lado
          (`SPEC-NEGOCIO §3.2`). Es la mitad del control: el dueño que cree
          que una tolerancia frena un cierre la configura como si fuera un
          freno. */}
      <p className="mt-3 flex items-start gap-2 border-t pt-2.5 text-xs leading-relaxed text-muted-foreground">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          Ninguna de las tres bloquea el cierre. Bloquearlo dejaría el turno abierto y vendiendo, que es
          el bug del turno abandonado: estas cifras exigen una causa y avisan, nunca frenan.
        </span>
      </p>
    </div>
  );
}

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

      <section className="space-y-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Scale className="size-4" aria-hidden="true" />
          <h3 className="text-xs font-bold tracking-wider uppercase">Diferencias del arqueo</h3>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Dos cifras, tres bandas. Son las únicas que mueven el umbral del cierre.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="cash-tolerance_unknown_cause">Tolerancia sin causa identificada</Label>
          <MoneyInput
            id="cash-tolerance_unknown_cause"
            value={values.tolerance_unknown_cause}
            onChange={(next) =>
              setValues((v) => (v ? { ...v, tolerance_unknown_cause: next ?? 0 } : v))
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cash-critical_difference">Diferencia crítica</Label>
          <MoneyInput
            id="cash-critical_difference"
            value={values.critical_difference}
            onChange={(next) => setValues((v) => (v ? { ...v, critical_difference: next ?? 0 } : v))}
          />
        </div>
        <BandasDelArqueo values={values} />
      </section>

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
