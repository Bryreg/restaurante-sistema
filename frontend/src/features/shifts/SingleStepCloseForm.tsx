import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Banknote, Calculator, ClipboardList, Receipt } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { useSession } from "@/app/session";
import { ApiError, newIdempotencyKey } from "@/api/client";
import { closeSingleStep, type CashDifferenceCause } from "@/api/shifts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DenominationsInput, type Denomination } from "@/components/DenominationsInput";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/MoneyInput";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { formatInstant } from "@/lib/businessDate";
import { DENOMINATIONS, formatCOP } from "@/lib/money";

import { PhotoCaptureField } from "./PhotoCaptureField";
import {
  CabeceraCierre,
  PanelSello,
  PasoPastilla,
  PropinasDelTurno,
  TarjetaCierre,
  type ResultadoCierre,
} from "./closeUi";
import { CURRENT_SHIFT_QUERY_KEY, shiftSummaryQueryKey, useCurrentShift, useShiftTips } from "./hooks";

const CAUSE_LABEL: Record<CashDifferenceCause, string> = {
  change_error: "Error al dar cambio",
  expense_without_voucher: "Gasto sin comprobante",
  tips_mixed: "Propinas mezcladas con la base",
  unrecorded_sale: "Venta no registrada",
  counting_error: "Error de conteo",
  unknown: "Sin identificar",
};

function emptyDenominations(): Denomination[] {
  return DENOMINATIONS.map((value) => ({ value, count: 0 }));
}

/**
 * Cierre en un solo paso — sólo cuando `cash.blind_close` está apagada.
 *
 * GAP: `features/fase-1a-cimientos/spec.md` documenta únicamente el cierre
 * en tres pasos; no lista una ruta de cierre de un solo paso. Este formulario
 * llama a `POST /shifts/{id}/close` (`closeSingleStep` en `api/shifts.ts`),
 * que existe en la implementación de `backend-caja` pero no en el contrato
 * escrito — ver la nota en `api/shifts.ts` y el detalle en el entregable de
 * este agente. Como no hay un paso de revisión previo, no se muestra ningún
 * esperado antes de mandar el conteo; recién en la pantalla de resultado
 * (después de que el servidor cierra el turno) aparecen `expected` y
 * `difference` — ambos calculados por el servidor.
 *
 * Caso restante (iteración 2, ajuste del Maestro): una tablet con flags
 * viejos puede llegar acá aunque la sede ya tenga `cash.blind_close`
 * encendida. El servidor lo rechaza con `400 BLIND_CLOSE_REQUIRED`
 * (`error.feature === "cash.blind_close"`) — acá NO se reintenta el POST:
 * se muestra el `message` del servidor tal cual y se dispara `refresh()` de
 * `useSession()` (vuelve a pedir `GET /auth/me`) para que `me.features` se
 * actualice y `ShiftPage` cambie de `SingleStepCloseForm` a `CloseWizard`
 * en el próximo render.
 *
 * **Iteración 3 (H-8)**: mismo agregado que `CloseWizard` — al lado del
 * campo de propinas se muestra, como REFERENCIA de sólo lectura, el
 * `cash_out` de `GET /shifts/{id}/tips` (`useShiftTips`).
 *
 * **Estructura (maqueta `m2b`)**: la misma que el asistente —paso a la
 * vista, billetes y monedas en dos columnas, piezas junto al total, panel
 * aparte para lo que el sistema calcula y promesa al pie del botón—, pero
 * con el texto que corresponde a ESTE camino: acá no hay conteo a ciegas
 * (la función está apagada) y no hay un paso 2 que revele nada; el esperado
 * y la diferencia llegan ya calculados cuando el turno queda cerrado.
 */
export function SingleStepCloseForm({
  shiftId,
  onClosed,
}: {
  shiftId: number;
  /**
   * Mismo contrato que `CloseWizard`: el resultado se lo queda `ShiftPage`,
   * que es quien sobrevive a que el turno pase a `null`.
   */
  onClosed: (resultado: ResultadoCierre) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const { refresh } = useSession();

  const [counted, setCounted] = useState<Denomination[]>(emptyDenominations());
  const [countedCard, setCountedCard] = useState<number | null>(null);
  const [countedTransfer, setCountedTransfer] = useState<number | null>(null);
  const [tipsCashOut, setTipsCashOut] = useState<number | null>(0);
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoRequired, setPhotoRequired] = useState(false);
  const [cause, setCause] = useState<CashDifferenceCause | "">("");
  const [note, setNote] = useState("");
  const [closesDay, setClosesDay] = useState(false);
  // El cierre en un solo paso no sabe de antemano cuántas comandas quedaron
  // abiertas: se entera por `400 OPEN_ORDERS_EXIST`. Recién ahí ofrece
  // trasladarlas — que es lo que el propio mensaje del servidor pide y hasta
  // ahora ninguna pantalla sabía hacer.
  const [openOrders, setOpenOrders] = useState(0);
  const [transferOpenOrders, setTransferOpenOrders] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idempotencyKeyRef = useRef(newIdempotencyKey());

  // Lo tecleado en la rejilla: la MISMA suma que ya viajaba en el cuerpo del
  // cierre (el servidor la valida contra las denominaciones). No es el
  // esperado ni la diferencia: esas las calcula el backend.
  const totalContado = counted.reduce((acc, d) => acc + d.value * d.count, 0);

  // Iteración 3 (H-8): misma referencia de sólo lectura que `CloseWizard` —
  // ver el comentario ahí. `cash_out` se pinta tal cual llega.
  const tipsQuery = useShiftTips(shiftId);
  const { data: turno } = useCurrentShift();
  const abiertoEn = turno?.opened_at ? formatInstant(turno.opened_at) : null;
  const responsable = turno?.cash_responsible?.name ?? null;

  const mutation = useMutation({
    mutationFn: () => {
      return closeSingleStep(
        shiftId,
        {
          counted_cash: { denominations: counted, total: totalContado },
          counted_card: countedCard,
          counted_transfer: countedTransfer,
          tips_cash_out: tipsCashOut ?? 0,
          photo,
          cause: cause === "" ? undefined : cause,
          note: note.trim() === "" ? undefined : note.trim(),
          closes_day: closesDay,
          transfer_open_orders: transferOpenOrders,
        },
        idempotencyKeyRef.current,
      );
    },
    onSuccess: (out) => {
      setError(null);
      // El resultado sube a la página ANTES de invalidar: es ella la que
      // dibuja «Turno cerrado» y la que no se desmonta cuando el turno
      // desaparece (ver `TarjetaTurnoCerrado` en `closeUi.tsx`).
      onClosed(out);
      toast.success("Turno cerrado.");
      // La invalidación sigue: el resto de la app no puede quedar con el
      // turno viejo en caché.
      void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shiftId) });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "BLIND_CLOSE_REQUIRED") {
        // La sede prendió "cierre a ciegas" mientras esta pantalla estaba
        // abierta (tablet con flags viejos): NO se reintenta el POST acá —
        // se muestra el mensaje del servidor y se refresca la sesión para
        // que `ShiftPage` cambie al wizard en cuanto `me.features` llegue.
        setError(errorMessage(err));
        void refresh();
        return;
      }
      if (
        err instanceof ApiError &&
        (err.code === "PHOTO_REQUIRED" ||
          err.code === "CAUSE_REQUIRED" ||
          err.code === "IDENTIFIED_CAUSE_REQUIRED" ||
          err.code === "OPEN_ORDERS_EXIST")
      ) {
        if (err.code === "PHOTO_REQUIRED") setPhotoRequired(true);
        if (err.code === "OPEN_ORDERS_EXIST") {
          const cuantas = err.extra?.open_orders;
          setOpenOrders(typeof cuantas === "number" && cuantas > 0 ? cuantas : 1);
        }
        // El próximo intento va a llevar un campo más: clave nueva.
        idempotencyKeyRef.current = newIdempotencyKey();
      }
      setError(errorMessage(err));
    },
  });

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      {/* La misma cabecera que el cierre a ciegas. `closeUi.tsx` lo dice en
          su encabezado y es el riesgo declarado en `docs/INVENTARIO-CONTROLES.md`
          §10.b: rediseñar un formulario de cierre y dejar el otro con la
          pantalla vieja. Los dos son el mismo momento del día. */}
      <CabeceraCierre turnoId={shiftId} abiertoEn={abiertoEn} responsable={responsable} contado={totalContado} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <TarjetaCierre
          icono={<Banknote />}
          titulo="Contar el cajón"
          pastilla={<PasoPastilla tono="activo">Paso único</PasoPastilla>}
        >
          <div className="px-4 py-3">
            <DenominationsInput value={counted} onChange={setCounted} legend="Efectivo contado" />
            <p className="pt-3 text-xs leading-relaxed text-muted-foreground">
              Contá por denominación y poné cuántas hay: el sistema hace la multiplicación. Se puede
              corregir hasta que cierres.
            </p>
          </div>
        </TarjetaCierre>

        <TarjetaCierre icono={<Receipt />} titulo="El resto del cierre">
          <div className="grid gap-4 px-4 py-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="single-close-card">Datáfono contado</Label>
              <MoneyInput id="single-close-card" value={countedCard} onChange={setCountedCard} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="single-close-transfer">Transferencias contadas</Label>
              <MoneyInput id="single-close-transfer" value={countedTransfer} onChange={setCountedTransfer} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="single-close-tips">Propinas en efectivo retiradas</Label>
              <MoneyInput id="single-close-tips" value={tipsCashOut} onChange={setTipsCashOut} />
              <p className="text-xs text-muted-foreground">
                Referencia del sistema (no se usa para calcular nada acá): lo que el sistema calcula que sale del
                cajón como propina es {formatCOP(tipsQuery.data?.cash_out)}.
              </p>
              <p className="text-xs text-muted-foreground">
                La propina en efectivo sale del cajón, pero no es un renglón del esperado: se salda aparte.
              </p>
            </div>
            <div className="sm:col-span-2">
              <PhotoCaptureField value={photo} onChange={setPhoto} required={photoRequired} />
            </div>
          </div>
        </TarjetaCierre>

        <TarjetaCierre icono={<ClipboardList />} titulo="Causa y día operativo">
          <div className="space-y-4 px-4 py-3">
            <div className="space-y-1">
              <Label htmlFor="single-close-cause">Causa de la diferencia (si hubo)</Label>
              <Select value={cause || undefined} onValueChange={(v) => setCause(v as CashDifferenceCause)}>
                <SelectTrigger id="single-close-cause" className="h-11 w-full">
                  <SelectValue placeholder="Sin diferencia / elegí una causa" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CAUSE_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="single-close-note">Nota</Label>
              <Textarea id="single-close-note" value={note} onChange={(event) => setNote(event.target.value)} />
            </div>
            {openOrders > 0 ? (
              <label className="flex items-start gap-2 rounded-md border border-dashed p-3 text-sm">
                <Checkbox
                  checked={transferOpenOrders}
                  onCheckedChange={(checked) => setTransferOpenOrders(Boolean(checked))}
                />
                <span>
                  Trasladar al turno siguiente {openOrders === 1 ? "la comanda abierta" : `las ${openOrders} comandas abiertas`}
                  <span className="block text-muted-foreground">
                    Quedan a la espera y las adopta quien abra el próximo turno.
                  </span>
                </span>
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={closesDay} onCheckedChange={(checked) => setClosesDay(Boolean(checked))} />
              Este cierre también cierra el día operativo
            </label>
          </div>
        </TarjetaCierre>
      </div>

      <PanelSello
        titulo="Lo que el sistema calcula"
        icono={<Calculator />}
        pastilla={<PasoPastilla tono="tapado">Al cerrar</PasoPastilla>}
        titular="El cuadre se hace al cerrar"
        razon={
          <>
            Este cierre es en un solo paso porque «cierre a ciegas» está apagado en esta sede: el formulario
            no te pide el esperado ni te lo compara mientras contás. El servidor arma la cuenta cuando
            cerrás.
          </>
        }
        nota={
          <>
            Los cinco renglones son los que el servidor usa para el esperado. Acá van sin cifra porque este
            formulario no los pide, no porque una regla los tape: el cierre a ciegas está apagado. La{" "}
            <b className="text-background">propina en efectivo</b> no es uno de ellos: sale del cajón por su
            propio renglón y se salda aparte.
          </>
        }
        promesa={
          <>
            Al cerrar, tu conteo queda guardado con su hora y el servidor devuelve el esperado, la
            diferencia y lo que hay que consignar. <b className="text-background">Después no se puede cambiar.</b>
          </>
        }
      >
        {error ? (
          <p role="alert" className="mb-3 rounded-md bg-background px-3 py-2 text-sm font-medium text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          type="button"
          className="h-auto w-full flex-col gap-0 py-2.5"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          <span className="text-sm font-normal">{mutation.isPending ? "Cerrando…" : "Cerrar turno con"}</span>
          <span className="text-xl font-bold tabular-nums">{formatCOP(totalContado)}</span>
        </Button>
      </PanelSello>
      </div>

      <PropinasDelTurno
        efectivo={tipsQuery.data?.cash_out}
        electronicas={tipsQuery.data?.electronic_liability}
        total={tipsQuery.data?.total_liability}
      />
    </div>
  );
}
