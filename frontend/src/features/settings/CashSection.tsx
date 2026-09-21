import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { getCashSettings, setCashSettings, type CashSettings } from "@/api/stores";
import { ConsequenceZone, FormField, FormSection, SaveBar, type PendingChange } from "@/components/admin";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/MoneyInput";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";
import { cn } from "cn";

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

const TONO_FRANJA: Record<Tono, string> = {
  ok: "bg-success/45",
  warn: "bg-warning/45",
  bad: "bg-destructive/45",
};

/**
 * **La escala** (`docs/PATRONES-ADMIN.md` § 9). Cuando varios campos vecinos
 * son fronteras de la misma recta, se dibuja la recta, a escala y teñida, con
 * **las franjas leídas de los campos y nunca al revés**: las fronteras son lo
 * editable, las franjas son su consecuencia.
 *
 * Dos montos y tres franjas, ni uno más. Lo único que se calcula acá son los
 * **anchos** —geometría de la barra, no plata—: las cifras que se leen son
 * las dos que el dueño tecleó, tal cual, con `formatCOP`. Un «$ 99.999»
 * derivado sería una cifra que el backend nunca mandó.
 */
function EscalaDelCierre({ values }: { values: CashSettings }): React.JSX.Element | null {
  const tolerancia = values.tolerance_unknown_cause;
  const critica = values.critical_difference;
  if (fronterasInvertidas({ tolerance_unknown_cause: tolerancia, critical_difference: critica })) return null;
  if (tolerancia <= 0 && critica <= 0) return null;

  // Anchos relativos, no importes. La cola de «alerta crítica» no tiene tope
  // —la diferencia puede ser cualquiera— así que se le da un tramo que se vea.
  const media = Math.max(critica - tolerancia, 1);
  const cola = Math.max(Math.round(media * 0.75), Math.max(tolerancia, 1));
  const franjas = [
    { tono: "ok" as Tono, peso: Math.max(tolerancia, 1), desde: formatCOP(0), dice: "Causa; «Sin identificar» sirve" },
    { tono: "warn" as Tono, peso: media, desde: formatCOP(tolerancia), dice: "Causa identificada" },
    { tono: "bad" as Tono, peso: cola, desde: formatCOP(critica), dice: "Alerta crítica" },
  ];

  return (
    <div aria-hidden="true">
      <div className="flex h-2.5 overflow-hidden rounded-full">
        {franjas.map((franja) => (
          <span key={franja.tono} style={{ flex: franja.peso }} className={TONO_FRANJA[franja.tono]} />
        ))}
      </div>
      <div className="mt-1 flex gap-2">
        {franjas.map((franja) => (
          <span key={franja.tono} style={{ flex: franja.peso }} className="min-w-0 text-[0.68rem] leading-tight">
            <b className={cn("block font-bold tabular-nums", TONO_RANGO[franja.tono])}>{franja.desde}</b>
            <span className="block text-muted-foreground">{franja.dice}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * **La lectura** (`docs/PATRONES-ADMIN.md` § 9): devuelve en palabras la regla
 * que el formulario está escribiendo, y con ella la validación cruzada que
 * ningún campo solo puede ver.
 *
 * Verde, ámbar y rojo son **de estado** (`docs/DISENO.md`): acá dicen en qué
 * banda cae una diferencia, no invitan a tocar nada. Lo único azul de la
 * pantalla sigue siendo el botón.
 */
function BandasDelArqueo({ values }: { values: CashSettings }): React.JSX.Element {
  const invertidas = fronterasInvertidas(values);

  if (invertidas) {
    return (
      <p role="alert" className="flex items-start gap-2 font-medium text-warning">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          La diferencia crítica tiene que ser mayor que la tolerancia sin causa identificada: subí la
          diferencia crítica o bajá la tolerancia. Así como están, la banda del medio no existe.
        </span>
      </p>
    );
  }

  return (
    <>
      <h4 className="text-xs font-bold tracking-wider text-muted-foreground uppercase">Cómo queda el arqueo</h4>
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
    </>
  );
}

/** El error de la validación cruzada, bajo los dos campos que la producen. */
const ERROR_ORDEN =
  "Tiene que quedar por debajo de la diferencia crítica: bajá esta tolerancia o subí la crítica.";

/**
 * Los cambios sin guardar, campo por campo y **con el valor viejo**
 * (`docs/PATRONES-ADMIN.md` § 12). `leaks` nombra los que salen de Ajustes:
 * es lo único que el dueño no puede adivinar mirando esta pantalla.
 */
function cambiosPendientes(guardado: CashSettings, actual: CashSettings): PendingChange[] {
  const plata: { key: keyof CashSettings; field: string; leaks?: string }[] = [
    { key: "opening_cash_fixed", field: "Base fija de apertura", leaks: "Cambia Dinero › Abrir turno" },
    { key: "cash_reserve_default", field: "Reserva por defecto", leaks: "Cambia Dinero › Abrir turno" },
    {
      key: "tolerance_unknown_cause",
      field: "Tolerancia sin causa identificada",
      leaks: "Cambia Salón › Cierre de turno, paso 2",
    },
    { key: "critical_difference", field: "Diferencia crítica", leaks: "Cambia Hoy › Requiere tu atención" },
    { key: "cash_pickup_threshold", field: "Umbral de retiro", leaks: "Cambia Salón › Turno" },
    {
      key: "petty_cash_limit",
      field: "Límite de gasto menor",
      leaks: "Frena Salón › Turno › Movimiento de caja",
    },
  ];

  const cambios: PendingChange[] = [];
  for (const { key, field, leaks } of plata) {
    const antes = guardado[key] as number;
    const ahora = actual[key] as number;
    if (antes !== ahora) cambios.push({ field, from: formatCOP(antes), to: formatCOP(ahora), leaks });
  }
  if (guardado.streak_alert_shifts !== actual.streak_alert_shifts) {
    cambios.push({
      field: "Turnos seguidos con diferencia para alertar",
      from: `${guardado.streak_alert_shifts} turnos`,
      to: `${actual.streak_alert_shifts} turnos`,
    });
  }
  const casillas: { key: keyof CashSettings; field: string; leaks: string }[] = [
    {
      key: "photo_required_on_close",
      field: "Foto obligatoria al cerrar turno",
      leaks: "Cambia Salón › Cierre de turno, paso 3",
    },
    {
      key: "photo_required_on_pickup",
      field: "Foto obligatoria en retiros",
      leaks: "Cambia Salón › Turno › Retiro",
    },
  ];
  for (const { key, field, leaks } of casillas) {
    const antes = guardado[key] as boolean;
    const ahora = actual[key] as boolean;
    if (antes !== ahora) {
      cambios.push({ field, from: antes ? "Sí se pide" : "No se pide", to: ahora ? "Sí se pide" : "No se pide", leaks });
    }
  }
  return cambios;
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
    /* Patrón 13, motivo «error»: qué contestó el servidor, y el formulario
       **queda bloqueado** en vez de dejar guardar sobre lo que no se leyó. */
    return (
      <EmptyState
        role="alert"
        reason="error"
        title="No se pudo cargar la configuración de caja"
        description={
          <>
            {errorMessage(query.error)} Los valores que se ven no son los vigentes, así que el formulario
            queda bloqueado en vez de dejarte guardar encima de algo que no se leyó.
          </>
        }
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  const guardado = query.data as CashSettings;
  const cambios = cambiosPendientes(guardado, values);
  const invertidas = fronterasInvertidas(values);

  function patch(next: Partial<CashSettings>) {
    setValues((v) => (v ? { ...v, ...next } : v));
  }

  async function handleSave() {
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
    <div className="space-y-3">
      <FormSection
        title="Con qué abre el cajón"
        governs="Con cuánto arranca el cajón cada vez que alguien abre turno en esta sede. El POS lo propone y el cajero puede corregirlo."
        reading={
          <>
            Cada turno de esta sede abre proponiendo{" "}
            <b className="font-bold text-foreground tabular-nums">{formatCOP(values.opening_cash_fixed)}</b> en
            el cajón. El cierre se mide contra ese monto; si el cajero lo corrige al abrir, la diferencia queda
            registrada con su nombre.
          </>
        }
      >
        <FormField
          label="Base fija de apertura"
          help="El efectivo con el que empieza cada turno. El cierre se mide contra esto; si el cajero la corrige, queda la diferencia registrada."
          scope={{ affects: [{ screen: "Dinero › Abrir turno", verb: "Aparece en" }] }}
        >
          {({ fieldId, describedBy }) => (
            <MoneyInput
              id={fieldId}
              aria-describedby={describedBy}
              value={values.opening_cash_fixed}
              onChange={(next) => patch({ opening_cash_fixed: next ?? 0 })}
            />
          )}
        </FormField>

        <FormField
          label="Reserva por defecto"
          help={
            <>
              Plata que se aparta del conteo y no cuenta como venta del turno. Con la función apagada el campo{" "}
              <b className="font-bold text-foreground">no aparece</b> al abrir turno, y el valor queda guardado
              sin uso.
            </>
          }
          scope={{
            flag: "cash.reserve",
            affects: [{ screen: "Dinero › Abrir turno", verb: "Enciende el campo en" }],
          }}
        >
          {({ fieldId, describedBy }) => (
            <MoneyInput
              id={fieldId}
              aria-describedby={describedBy}
              value={values.cash_reserve_default}
              onChange={(next) => patch({ cash_reserve_default: next ?? 0 })}
            />
          )}
        </FormField>
      </FormSection>

      <FormSection
        title="Cuánto puede desajustar un cierre"
        governs="Dos montos, y de ellos salen las tres franjas del cierre. Cada frontera cambia lo que el cierre le exige a la persona, no el color del número."
        scale={<EscalaDelCierre values={values} />}
        reading={<BandasDelArqueo values={values} />}
        doesNotDo={
          <>
            <b className="font-bold text-foreground">
              Ninguna de las tres bloquea el cierre.
            </b>{" "}
            Bloquearlo dejaría el turno abierto y vendiendo, que es el bug del turno abandonado: estas cifras
            exigen una causa y avisan, nunca frenan.
          </>
        }
      >
        <FormField
          label="Tolerancia sin causa identificada"
          help={
            <>
              Hasta este monto el cajero elige una causa pero{" "}
              <b className="font-bold text-foreground">«Sin identificar» sigue sirviendo</b>. Pasado el monto
              desaparece de la lista y hay que elegir una de las causas tipadas en Ventas.
            </>
          }
          error={invertidas ? ERROR_ORDEN : undefined}
          scope={{ affects: [{ screen: "Salón › Cierre de turno, paso 2", verb: "Cambia" }] }}
        >
          {({ fieldId, describedBy }) => (
            <MoneyInput
              id={fieldId}
              aria-describedby={describedBy}
              aria-invalid={invertidas}
              value={values.tolerance_unknown_cause}
              onChange={(next) => patch({ tolerance_unknown_cause: next ?? 0 })}
            />
          )}
        </FormField>

        <FormField
          label="Diferencia crítica"
          help="Desde este monto sale la alerta crítica al administrador y el turno queda marcado para revisión."
          scope={{ affects: [{ screen: "Hoy › Requiere tu atención", verb: "Aparece en" }] }}
        >
          {({ fieldId, describedBy }) => (
            <MoneyInput
              id={fieldId}
              aria-describedby={describedBy}
              aria-invalid={invertidas}
              value={values.critical_difference}
              onChange={(next) => patch({ critical_difference: next ?? 0 })}
            />
          )}
        </FormField>

        <FormField
          label="Turnos seguidos con diferencia para alertar"
          help="Aunque cada uno esté dentro de tolerancia y lo cierre la misma persona. Una diferencia es un error; tres seguidas son otra cosa."
          scope={{ affects: [{ screen: "Notificaciones › Racha de diferencias", verb: "Avisa en" }] }}
        >
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              type="number"
              min={1}
              className="h-11"
              value={values.streak_alert_shifts}
              onChange={(e) => patch({ streak_alert_shifts: Number(e.target.value) })}
            />
          )}
        </FormField>
      </FormSection>

      <FormSection
        title="Retiros y gasto menor"
        governs="Los dos montos que deciden cuándo el sistema deja de creerle a quien está en la caja y pide un PIN de administrador."
        reading={
          <>
            Con más de{" "}
            <b className="font-bold text-foreground tabular-nums">{formatCOP(values.cash_pickup_threshold)}</b>{" "}
            en el cajón, el turno sugiere retirar y consignar —sugiere, no obliga—. Un gasto menor de más de{" "}
            <b className="font-bold text-foreground tabular-nums">{formatCOP(values.petty_cash_limit)}</b> sí se
            frena: el servidor contesta <code className="font-mono text-xs">PETTY_CASH_LIMIT</code> y pide el PIN
            de administrador antes de que la plata salga del cajón.
          </>
        }
      >
        <FormField
          label="Umbral de retiro"
          help="Con más de esto en el cajón, el turno sugiere sacar plata y consignarla."
          scope={{ affects: [{ screen: "Salón › Turno", verb: "Sugerencia en" }] }}
        >
          {({ fieldId, describedBy }) => (
            <MoneyInput
              id={fieldId}
              aria-describedby={describedBy}
              value={values.cash_pickup_threshold}
              onChange={(next) => patch({ cash_pickup_threshold: next ?? 0 })}
            />
          )}
        </FormField>

        <FormField
          label="Límite de gasto menor"
          help={
            <>
              Un gasto por encima de este monto hace que el servidor conteste{" "}
              <code className="font-mono text-xs">PETTY_CASH_LIMIT</code> y el movimiento se frene antes de
              salir del cajón.
            </>
          }
          scope={{
            affects: [{ screen: "Salón › Turno › Movimiento de caja", verb: "Frena" }],
            requires: "PIN de administrador",
          }}
        >
          {({ fieldId, describedBy }) => (
            <MoneyInput
              id={fieldId}
              aria-describedby={describedBy}
              value={values.petty_cash_limit}
              onChange={(next) => patch({ petty_cash_limit: next ?? 0 })}
            />
          )}
        </FormField>
      </FormSection>

      {/* Patrón 11 · zona ÁMBAR. Apagar la foto obligatoria no borra las ya
          tomadas: la foto simplemente deja de pedirse. Reversible, sin
          pérdida — por eso no es la zona roja, que se guarda para lo que no
          se deshace (rotar el PIN de la sede, en Sedes). */}
      <ConsequenceZone
        level="reversible"
        scope="Tablet del salón"
        explanation="Estas dos casillas no cambian ningún número acá: encienden un campo en la tablet del salón. Apagarlas no borra las fotos ya tomadas — la foto simplemente deja de pedirse."
      >
        <div className="space-y-3">
          <label className="flex items-start gap-2.5 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={values.photo_required_on_close}
              onCheckedChange={(c) => patch({ photo_required_on_close: c === true })}
            />
            <span className="min-w-0">
              <b className="font-bold">Foto obligatoria al cerrar turno</b>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                Quien cierra tiene que fotografiar el cajón contado antes de confirmar; el servidor contesta{" "}
                <code className="font-mono">PHOTO_REQUIRED</code> si falta. Es la única prueba de qué había
                cuando se contó.
              </span>
              <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[0.72rem] text-muted-foreground">
                <span className="rounded-full border border-dashed border-input bg-card px-2 py-px">
                  Enciende el campo en{" "}
                  <b className="font-bold text-foreground">Salón › Cierre de turno, paso 3</b>
                </span>
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2.5 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={values.photo_required_on_pickup}
              onCheckedChange={(c) => patch({ photo_required_on_pickup: c === true })}
            />
            <span className="min-w-0">
              <b className="font-bold">Foto obligatoria en retiros</b>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                Cada retiro queda con la foto del sobre. Sin esto, el retiro se registra con el monto y nada
                más. Las fotos ya tomadas quedan donde están.
              </span>
              <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[0.72rem] text-muted-foreground">
                <span className="rounded-full border border-dashed border-input bg-card px-2 py-px">
                  Enciende el campo en <b className="font-bold text-foreground">Salón › Turno › Retiro</b>
                </span>
              </span>
            </span>
          </label>
        </div>
      </ConsequenceZone>

      {error ? (
        <p role="alert" className="flex items-start gap-2 text-sm font-medium text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}

      <SaveBar
        sectionName="Caja"
        changes={cambios}
        saving={saving}
        onSave={() => void handleSave()}
        onDiscard={() => setValues(guardado)}
      />
    </div>
  );
}
