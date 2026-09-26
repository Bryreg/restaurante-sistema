import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, Check, CircleCheck, ClipboardCheck, Lock, Receipt, RotateCcw } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { ApiError, newIdempotencyKey } from "@/api/client";
import {
  closeCount,
  confirmClose,
  getClosePrecheck,
  getCloseReview,
  type CardTransferReview,
  type CashDifferenceCause,
  type ClosePrecheck,
  type ClosePrecheckItem,
  type CloseReview,
} from "@/api/shifts";
import { useSession } from "@/app/session";
import { Cargando } from "@/components/Cargando";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DenominationKeypad } from "@/components/DenominationKeypad";
import { type Denomination } from "@/components/DenominationsInput";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/MoneyInput";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { cn } from "cn";
import { DENOMINATIONS, formatCOP } from "@/lib/money";

import { PhotoCaptureField } from "./PhotoCaptureField";
import {
  DiferenciaDeCaja,
  FilaCuadre,
  PanelSello,
  PasoPastilla,
  RENGLONES_ESPERADO,
  TarjetaCierre,
  type ResultadoCierre,
} from "./closeUi";
import { CURRENT_SHIFT_QUERY_KEY, shiftSummaryQueryKey, useShiftTips } from "./hooks";

/**
 * Un medio contado contra lo que el sistema espera.
 *
 * `registered` es lo que tiene que marcar el lote del datáfono: **venta más
 * propina**. Antes se comparaba contra la venta sola y todo turno con
 * propinas de tarjeta cerraba con una diferencia igual, al peso, a esas
 * propinas; una diferencia que aparece todos los días enseña a ignorar las
 * diferencias. Cuando hay propina se muestra la composición, para que el
 * número esperado no parezca salido de la nada.
 */
function MedioContado({ titulo, medio }: { titulo: string; medio?: CardTransferReview }): React.JSX.Element {
  const propina = medio?.tips ?? 0;
  return (
    <div className="rounded-md border p-3 text-sm">
      <p className="font-medium">{titulo}</p>
      <p className="text-muted-foreground">
        Registrado <span className="tabular-nums">{formatCOP(medio?.registered)}</span> · Contado{" "}
        <span className="tabular-nums">{formatCOP(medio?.counted)}</span> · Diferencia{" "}
        <span className="tabular-nums">{formatCOP(medio?.difference)}</span>
      </p>
      {propina > 0 ? (
        <p className="text-xs text-muted-foreground">
          Registrado = venta {formatCOP(medio?.sales)} + propina {formatCOP(propina)}
        </p>
      ) : null}
    </div>
  );
}

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

type Step = 0 | 1 | 2 | 3;

/**
 * «Paso 0»: lo que el servidor dice que el cierre va a exigir, ANTES de
 * contar. Sin ningún monto (el precheck no los publica): comandas abiertas
 * (con el camino para cobrarlas, o el aviso de que se trasladan en el paso
 * 3), domicilios sin liquidar y lo que se va a pedir.
 */
function PasoCero({
  precheck,
  onContar,
  onRevisar,
  revisando,
}: {
  precheck: ClosePrecheck;
  onContar: () => void;
  onRevisar: () => void;
  revisando: boolean;
}): React.JSX.Element {
  const { hasFeature } = useSession();
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <TarjetaCierre
        icono={<ClipboardCheck />}
        titulo="Antes de contar"
        pastilla={<PasoPastilla tono="activo">Paso 0</PasoPastilla>}
      >
        <ul className="space-y-3 px-4 py-3">
          {precheck.items.map((item) => (
            <ItemPrecheck
              key={item.code}
              item={item}
              mesas={hasFeature("pos.tables")}
              delivery={hasFeature("pos.delivery")}
            />
          ))}
        </ul>
      </TarjetaCierre>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="button" variant="outline" className="h-12 text-base" disabled={revisando} onClick={onRevisar}>
          {revisando ? "Revisando…" : "Ya lo resolví, revisar de nuevo"}
        </Button>
        <Button type="button" className="h-12 text-base" onClick={onContar}>
          Contar el cajón
        </Button>
      </div>
    </div>
  );
}

function ItemPrecheck({
  item,
  mesas,
  delivery,
}: {
  item: ClosePrecheckItem;
  mesas: boolean;
  delivery: boolean;
}): React.JSX.Element {
  const tono =
    item.level === "blocking"
      ? "border-destructive/60 bg-destructive/5"
      : item.level === "warning"
        ? "border-warning/60 bg-warning/5"
        : "border-border";
  return (
    <li className={cn("space-y-2 rounded-lg border p-3 text-sm", tono)}>
      <p className={item.level === "blocking" ? "font-medium text-destructive" : undefined}>{item.message}</p>
      {item.code === "OPEN_ORDERS" ? (
        <div className="flex flex-wrap items-center gap-2">
          {mesas ? (
            <Button variant="outline" className="h-11" nativeButton={false} render={<Link to="/pos/mesas" />}>
              Cobrar en Mesas
            </Button>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Si quedan para el turno siguiente, las trasladás al confirmar el cierre (paso 3).
          </p>
        </div>
      ) : null}
      {item.code === "DELIVERY_UNSETTLED" && delivery ? (
        <Button
          variant="outline"
          className="h-11"
          nativeButton={false}
          render={<Link to="/pos/turno?accion=domicilios" />}
        >
          Liquidar domicilios
        </Button>
      ) : null}
      {item.code === "RESERVE_LOAN_OPEN" ? (
        <Button variant="outline" className="h-11" nativeButton={false} render={<Link to="/pos/turno?accion=base" />}>
          Devolver a la base
        </Button>
      ) : null}
    </li>
  );
}

/**
 * Cierre a ciegas en tres pasos (`cash.blind_close`, spec § "Business day &
 * shifts"): el paso 1 **nunca** muestra ni pide el esperado, y no dispara
 * ningún pedido de review antes de tener `count_id` (por eso `getCloseReview`
 * vive en un `useQuery` con `enabled: step === 2`, nunca en un `useEffect`
 * disparado por otra cosa). El paso 3 manda `difference_seen` exactamente
 * como lo mostró el paso 2; si el servidor responde `400 DIFFERENCE_CHANGED`
 * vuelve al paso 2 con la review nueva que trae el propio error.
 *
 * **Paso 0 y retomar (auditoría de tablet)**: antes de contar se pide `GET
 * /shifts/{id}/close/precheck`, que dice —sin ningún monto— lo que el cierre
 * va a exigir (comandas abiertas, domicilios sin liquidar, datáfono,
 * transferencias, foto); antes las comandas abiertas aparecían recién en el
 * paso 3, con el conteo ya sellado. Si el precheck trae un conteo sellado,
 * el cierre se retoma en el paso 2 en vez de volver a contar desde cero; y
 * «Volver a contar» desde el paso 2 avisa que el conteo nuevo le queda
 * marcado al administrador como «recontado después de ver el esperado» (la
 * marca la pone el servidor).
 *
 * **Iteración 3 (H-8)**: al lado del campo de propinas del paso 1 se
 * muestra, como REFERENCIA de sólo lectura, `cash_out` de `GET
 * /shifts/{id}/tips` (`useShiftTips`) — lo que el servidor calcula que sale
 * del cajón como propina. No se usa para calcular ni validar
 * `tipsCashOut`: sólo se pinta.
 *
 * **Estructura (maqueta `m2b`, pestaña «Cierre de caja»)**: el paso está
 * numerado y a la vista; el candado es el protagonista del paso tapado; el
 * desglose del esperado se muestra renglón por renglón con `•••••` en el
 * paso 1 y con cifras en el paso 2 — **los mismos rótulos, en el mismo
 * orden**. Los renglones tapados son `RENGLONES_ESPERADO`, una constante de
 * rótulos: el paso 1 no le pregunta nada al servidor sobre el cajón, ni
 * siquiera la base.
 */
export function CloseWizard({
  shiftId,
  onClosed,
}: {
  shiftId: number;
  /**
   * El cierre entró: se le entrega el resultado a `ShiftPage`, que es quien
   * dibuja la pantalla de «Turno cerrado». Este formulario NO la dibuja,
   * porque la invalidación que sigue lo desmonta (ver `TarjetaTurnoCerrado`).
   */
  onClosed: (resultado: ResultadoCierre) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();

  // `null` hasta que responde el paso 0: dónde arranca lo decide el servidor.
  const [step, setStep] = useState<Step | null>(null);
  const [countId, setCountId] = useState<number | null>(null);
  // Retomado: el conteo ya estaba sellado cuando se abrió esta pantalla.
  const [retomado, setRetomado] = useState(false);
  const [confirmarRecuento, setConfirmarRecuento] = useState(false);

  // Paso 1
  const [counted, setCounted] = useState<Denomination[]>(emptyDenominations());
  const [countedCard, setCountedCard] = useState<number | null>(null);
  const [countedTransfer, setCountedTransfer] = useState<number | null>(null);
  const [tipsCashOut, setTipsCashOut] = useState<number | null>(0);
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoRequired, setPhotoRequired] = useState(false);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  // Paso 3
  const [manualReview, setManualReview] = useState<CloseReview | null>(null);
  const [cause, setCause] = useState<CashDifferenceCause | "">("");
  const [note, setNote] = useState("");
  const [closesDay, setClosesDay] = useState(false);
  const [closesDayTouched, setClosesDayTouched] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [transferOpenOrders, setTransferOpenOrders] = useState(false);

  const step1KeyRef = useRef(newIdempotencyKey());

  // Paso 0: el chequeo previo del servidor, sin montos. Decide dónde arranca
  // el cierre: si ya hay un conteo sellado, se retoma en el paso 2 (no se
  // vuelve a contar); si hay algo que resolver antes, el paso 0; si no, el 1.
  const precheckQuery = useQuery({
    queryKey: ["shifts", "close-precheck", shiftId],
    queryFn: () => getClosePrecheck(shiftId),
    staleTime: 0,
  });
  const precheck = precheckQuery.data ?? null;
  const pendientesAntes = (precheck?.items ?? []).filter((i) => i.level !== "info");
  const avisosDelCierre = (precheck?.items ?? []).filter((i) => i.level === "info");

  // El paso inicial se fija una sola vez, durante el render, apenas llega el
  // paso 0 (el patrón de React para ajustar estado a un dato nuevo).
  if (step === null && precheckQuery.isError) {
    setStep(1);
  } else if (step === null && precheck) {
    if (precheck.sealed_count) {
      setCountId(precheck.sealed_count.count_id);
      setRetomado(true);
      setStep(2);
    } else {
      setStep(precheck.items.some((i) => i.level !== "info") ? 0 : 1);
    }
  }

  // Lo tecleado en la rejilla de denominaciones: la MISMA suma que ya viajaba
  // en el cuerpo de `closeCount` (el servidor la valida contra las
  // denominaciones). No es el esperado ni la diferencia — esas las calcula el
  // backend y llegan en la review.
  const totalContado = counted.reduce((acc, d) => acc + d.value * d.count, 0);
  const piezasContadas = counted.reduce((acc, d) => acc + d.count, 0);

  // Iteración 3 (H-8): sólo REFERENCIA de sólo lectura junto al campo de
  // propinas — `GET /shifts/{id}/tips` es alcanzable con sesión de
  // dispositivo (`app/shifts/router.py:339` usa `current_actor`, admite
  // device con persona identificada). `cash_out` se pinta tal cual llega,
  // nunca se suma ni se resta contra `tipsCashOut`.
  const tipsQuery = useShiftTips(shiftId);

  const countMutation = useMutation({
    mutationFn: () => {
      return closeCount(
        shiftId,
        {
          counted_cash: { denominations: counted, total: totalContado },
          counted_card: countedCard,
          counted_transfer: countedTransfer,
          tips_cash_out: tipsCashOut ?? 0,
          photo,
        },
        step1KeyRef.current,
      );
    },
    onSuccess: (out) => {
      if (out.count_id === undefined) {
        setStep1Error("El servidor no devolvió el conteo. Intentá de nuevo.");
        return;
      }
      setCountId(out.count_id);
      setStep1Error(null);
      setManualReview(null);
      setStep(2);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "PHOTO_REQUIRED") {
        setPhotoRequired(true);
        step1KeyRef.current = newIdempotencyKey();
      }
      setStep1Error(errorMessage(err));
    },
  });

  // El único pedido que puede revelar el esperado: SOLO se dispara cuando ya
  // existe `countId` (paso 2 en adelante), nunca antes.
  const reviewQuery = useQuery({
    queryKey: ["shifts", "close-review", shiftId, countId],
    queryFn: () => getCloseReview(shiftId, countId as number),
    enabled: countId !== null && step === 2,
  });

  const review = manualReview ?? reviewQuery.data ?? null;

  function goToStep3() {
    if (!review) return;
    setCause("");
    setNote("");
    setClosesDay(Boolean(review.closes_day_suggested));
    setClosesDayTouched(false);
    setConfirmError(null);
    setStep(3);
  }

  const confirmMutation = useMutation({
    mutationFn: () => {
      if (countId === null || !review || review.difference === undefined) {
        throw new Error("Todavía no hay una revisión del cierre para confirmar.");
      }
      return confirmClose(shiftId, countId, {
        difference_seen: review.difference,
        cause: cause === "" ? undefined : cause,
        note: note.trim() === "" ? undefined : note.trim(),
        closes_day: closesDay,
        transfer_open_orders: transferOpenOrders,
      });
    },
    onSuccess: (out) => {
      setConfirmError(null);
      // Primero se entrega el resultado a la página: cuando la invalidación
      // haga que `GET /shifts/current` devuelva `null`, `ShiftPage` ya va a
      // tener qué mostrar en lugar de `OpenShiftForm`.
      onClosed(out);
      // El resto de la app no puede quedar con datos viejos: el turno dejó
      // de existir y el resumen cambió.
      void queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: shiftSummaryQueryKey(shiftId) });
      toast.success("Turno cerrado.");
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "DIFFERENCE_CHANGED") {
        const newReview = err.extra.review as CloseReview | undefined;
        if (newReview) {
          setManualReview(newReview);
          setStep(2);
          toast.error("La diferencia cambió: revisá el resumen actualizado.");
          return;
        }
      }
      if (err instanceof ApiError && err.code === "CLOSE_COUNT_SUPERSEDED") {
        // Otro conteo lo reemplazó (desde otra tablet): se retoma el vigente.
        void precheckQuery.refetch().then((r) => {
          const vigente = r.data?.sealed_count;
          if (!vigente) return;
          setManualReview(null);
          setCountId(vigente.count_id);
          setRetomado(true);
          setStep(2);
        });
      }
      setConfirmError(errorMessage(err));
    },
  });

  function volverAContar() {
    setConfirmarRecuento(false);
    setCounted(emptyDenominations());
    setCountedCard(null);
    setCountedTransfer(null);
    setTipsCashOut(0);
    setPhoto(null);
    setStep1Error(null);
    setManualReview(null);
    setRetomado(false);
    step1KeyRef.current = newIdempotencyKey();
    setStep(1);
  }

  if (step === null) {
    return <Cargando texto="Revisando qué pide el cierre…" />;
  }

  if (step === 0 && precheck) {
    return (
      <PasoCero
        precheck={precheck}
        revisando={precheckQuery.isFetching}
        onRevisar={() => {
          void precheckQuery.refetch().then((r) => {
            if (r.data && !r.data.items.some((i) => i.level !== "info")) setStep(1);
          });
        }}
        onContar={() => setStep(1)}
      />
    );
  }

  if (step === 0 || step === 1) {
    return (
      <div className="mx-auto grid w-full max-w-6xl items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <TarjetaCierre
            icono={<Banknote />}
            titulo="Contar el cajón"
            pastilla={<PasoPastilla tono="activo">Paso 1 de 3</PasoPastilla>}
          >
            <div className="px-4 py-3">
              {pendientesAntes.length > 0 ? (
                <p className="mb-3 rounded-md border border-warning/60 bg-warning/5 px-3 py-2 text-sm">
                  Quedó pendiente del paso 0: {pendientesAntes.map((i) => i.message).join(" · ")}
                </p>
              ) : null}
              <DenominationKeypad value={counted} onChange={setCounted} legend="Efectivo contado" />
              <p className="pt-3 text-xs leading-relaxed text-muted-foreground">
                Tocá la denominación, escribí cuántas hay en el teclado y seguí con «›»: el sistema hace la
                multiplicación. Se puede corregir hasta que confirmes.
              </p>
            </div>
          </TarjetaCierre>

          <TarjetaCierre icono={<Receipt />} titulo="El resto del cierre">
            <div className="grid gap-4 px-4 py-3 sm:grid-cols-2">
              {avisosDelCierre.length > 0 ? (
                <ul className="space-y-1 text-sm text-muted-foreground sm:col-span-2">
                  {avisosDelCierre.map((i) => (
                    <li key={i.code}>• {i.message}</li>
                  ))}
                </ul>
              ) : null}
              <div className="space-y-1">
                <Label htmlFor="close-card">Datáfono contado</Label>
                <MoneyInput id="close-card" value={countedCard} onChange={setCountedCard} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="close-transfer">Transferencias contadas</Label>
                <MoneyInput id="close-transfer" value={countedTransfer} onChange={setCountedTransfer} />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="close-tips">Propinas en efectivo retiradas</Label>
                <MoneyInput id="close-tips" value={tipsCashOut} onChange={setTipsCashOut} />
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
        </div>

        <PanelSello
          titulo="Lo que el sistema espera"
          pastilla={
            <PasoPastilla tono="tapado">
              <Lock aria-hidden="true" className="size-3" /> Paso 2 · tapado
            </PasoPastilla>
          }
          titular="Se cuenta a ciegas, y es a propósito"
          razon={
            <>
              Hasta que no confirmes, acá no aparece cuánta plata debería haber en el cajón. Si la vieras
              antes, el número que entregás dejaría de ser el que contaste y pasaría a ser el que había que
              dar.
            </>
          }
          nota={
            <>
              Ni la <b className="text-background">base</b> se muestra todavía: este paso no le pregunta nada
              al servidor sobre el cajón. La ecuación entera se abre de una sola vez en el paso 2.
            </>
          }
          promesa={
            <>
              Tu conteo se guarda con su hora <b className="text-background">antes</b> de que esta tarjeta se
              abra. Después no se puede cambiar.
            </>
          }
        >
          {step1Error ? (
            <p role="alert" className="mb-3 rounded-md bg-background px-3 py-2 text-sm font-medium text-destructive">
              {step1Error}
            </p>
          ) : null}
          <Button
            type="button"
            className="h-auto w-full flex-col gap-0 py-2.5"
            disabled={countMutation.isPending}
            onClick={() => countMutation.mutate()}
          >
            <span className="text-sm font-normal">
              {countMutation.isPending ? "Congelando conteo…" : "Confirmar el conteo y continuar"}
            </span>
            <span className="text-xl font-bold tabular-nums">{formatCOP(totalContado)}</span>
          </Button>
        </PanelSello>
      </div>
    );
  }

  if (step === 2) {
    if (reviewQuery.isLoading && !manualReview) {
      return <p className="text-sm text-muted-foreground">Calculando el esperado…</p>;
    }
    if (reviewQuery.isError && !manualReview) {
      return (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(reviewQuery.error)}
        </p>
      );
    }
    if (!review) {
      return <p className="text-sm text-muted-foreground">Sin datos de revisión todavía.</p>;
    }
    const diferencia = review.difference;
    // Lo contado: lo que se tecleó en esta pantalla o —si se retomó un conteo
    // ya sellado— lo que el servidor guardó al sellarlo.
    const contadoMostrado = retomado ? (review.counted ?? null) : totalContado;
    const piezasMostradas = retomado ? (review.counted_pieces ?? null) : piezasContadas;
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4">
        {retomado ? (
          <p role="status" className="rounded-md border px-3 py-2 text-sm">
            Retomaste un cierre que ya tenía el conteo sellado
            {precheck?.sealed_count ? ` por ${precheck.sealed_count.counted_by}` : ""}: seguís desde el paso 2.
          </p>
        ) : null}
        <TarjetaCierre
          icono={<CircleCheck />}
          titulo="Lo que el sistema esperaba"
          acento="ok"
          pastilla={<PasoPastilla tono="listo">Paso 2 de 3 · abierto</PasoPastilla>}
        >
          <div className="px-4 py-3">
            <div className="flex flex-wrap items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
              <PasoPastilla tono="listo">
                <Check aria-hidden="true" className="size-3" /> Paso 1 · sellado
              </PasoPastilla>
              <p className="min-w-0 flex-1">
                Tu conteo quedó sellado en el servidor <b>antes</b> de que esta tarjeta se abriera: lo que
                veas acá ya no lo puede cambiar.
              </p>
            </div>

            <div className="mt-3">
              {RENGLONES_ESPERADO.map(({ clave, rotulo, detalle, signo }) => (
                <FilaCuadre
                  key={clave}
                  rotulo={rotulo}
                  detalle={detalle}
                  signo={signo}
                  valor={review.equation?.[clave]}
                />
              ))}
              {/* Lo consignado desde el cajón (2026-09-24) sale del esperado.
                  Sólo se pinta si el servidor lo publica en `equation`: el
                  renglón tapado del paso 1 no lo lista, así que no se revela
                  nada que no se haya visto antes de sellar. */}
              {review.equation?.deposits !== undefined ? (
                <FilaCuadre
                  rotulo="Consignado desde el cajón"
                  detalle="Plata de días anteriores que se llevó al banco"
                  signo="−"
                  valor={review.equation.deposits}
                />
              ) : null}
              {/* Lo prestado por la base de respaldo (2026-09-26) está en el
                  cajón y suma. El conteo no entra con préstamo abierto, así
                  que acá casi siempre es 0; se pinta si el servidor lo manda. */}
              {review.equation?.reserve_loan ? (
                <FilaCuadre
                  rotulo="Prestado por la base de respaldo"
                  detalle="Se devuelve antes del cierre"
                  signo="+"
                  valor={review.equation.reserve_loan}
                />
              ) : null}
              <FilaCuadre rotulo="Esperado" detalle="Lo que debería haber en el cajón" valor={review.expected} remate />
              <FilaCuadre
                rotulo="Contado a mano"
                detalle={
                  piezasMostradas === null ? undefined : piezasMostradas === 1 ? "1 pieza" : `${piezasMostradas} piezas`
                }
                valor={contadoMostrado}
                className="border-t border-border"
              />
            </div>

            <DiferenciaDeCaja diferencia={diferencia} className="mt-3" />
          </div>
        </TarjetaCierre>

        <div className="grid gap-3 sm:grid-cols-2">
          <MedioContado titulo="Datáfono" medio={review.card} />
          <MedioContado titulo="Transferencias" medio={review.transfer} />
        </div>

        {review.is_critical ? (
          <p role="alert" className="rounded-md bg-destructive/10 p-2 text-sm font-medium text-destructive">
            Diferencia crítica: se va a notificar al administrador.
          </p>
        ) : null}

        <div className="flex flex-wrap items-start gap-2">
          <Button type="button" className="h-12 text-base" onClick={goToStep3}>
            Continuar
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-12 gap-2 text-base"
            aria-expanded={confirmarRecuento}
            onClick={() => setConfirmarRecuento((v) => !v)}
          >
            <RotateCcw aria-hidden="true" className="size-4" /> Volver a contar
          </Button>
        </div>
        {confirmarRecuento ? (
          <div role="alert" className="space-y-2 rounded-md border border-warning/60 bg-warning/5 p-3 text-sm">
            <p>
              Ya viste lo que el sistema esperaba. Si volvés a contar, el conteo nuevo reemplaza al sellado y le
              queda al administrador la marca <b>«recontado después de ver el esperado»</b>.
            </p>
            <Button type="button" variant="outline" className="h-11" onClick={volverAContar}>
              Sí, volver a contar
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  // step === 3
  if (!review) {
    return <p className="text-sm text-muted-foreground">Volvé al paso anterior: no hay revisión cargada.</p>;
  }
  const openOrders = review.open_orders ?? 0;
  const requiresCause = Boolean(review.requires_cause);
  const requiresIdentified = Boolean(review.requires_identified_cause);
  const causeOptions = requiresIdentified
    ? (Object.entries(CAUSE_LABEL).filter(([value]) => value !== "unknown") as [CashDifferenceCause, string][])
    : (Object.entries(CAUSE_LABEL) as [CashDifferenceCause, string][]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <TarjetaCierre
        icono={<Lock />}
        titulo="Confirmar el cierre"
        pastilla={<PasoPastilla tono="activo">Paso 3 de 3</PasoPastilla>}
      >
        <div className="space-y-4 px-4 py-3">
          <DiferenciaDeCaja diferencia={review.difference} anunciaCausa={false} />

          {requiresCause ? (
            <div className="space-y-3">
              {requiresIdentified ? (
                <p role="alert" className="text-sm font-medium text-destructive">
                  La diferencia supera la tolerancia de causa desconocida: elegí una causa identificada.
                </p>
              ) : null}
              {/* Botones grandes y no un desplegable: se elige con un toque, de pie
                  y cansada, y las opciones se ven todas a la vez. */}
              <div className="space-y-2">
                <p id="close-cause-label" className="text-sm font-medium">
                  ¿Qué creés que pasó?
                </p>
                <div role="radiogroup" aria-labelledby="close-cause-label" className="grid gap-2 sm:grid-cols-2">
                  {causeOptions.map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={cause === value}
                      onClick={() => setCause(value)}
                      className={cn(
                        "min-h-14 rounded-lg px-4 text-left text-base font-semibold ring-1 transition-colors",
                        cause === value
                          ? "bg-foreground text-background ring-foreground"
                          : "bg-card text-foreground ring-border hover:bg-muted",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="close-cause-note">Nota</Label>
                <Textarea id="close-cause-note" value={note} onChange={(event) => setNote(event.target.value)} />
              </div>
            </div>
          ) : null}

          {openOrders > 0 ? (
            <label className="flex items-start gap-2 rounded-md border border-dashed p-3 text-sm">
              <Checkbox
                checked={transferOpenOrders}
                onCheckedChange={(checked) => setTransferOpenOrders(Boolean(checked))}
              />
              <span>
                Trasladar al turno siguiente {openOrders === 1 ? "la comanda abierta" : `las ${openOrders} comandas abiertas`}
                <span className="block text-muted-foreground">
                  Quedan a la espera y las adopta quien abra el próximo turno. Sin esto hay que cobrarlas o anularlas
                  antes de cerrar.
                </span>
              </span>
            </label>
          ) : null}

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={closesDay}
              onCheckedChange={(checked) => {
                setClosesDay(Boolean(checked));
                setClosesDayTouched(true);
              }}
            />
            Este cierre también cierra el día operativo
            {!closesDayTouched && review.closes_day_suggested ? " (sugerido)" : ""}
          </label>

          {confirmError ? (
            <p role="alert" className="text-sm text-destructive">
              {confirmError}
            </p>
          ) : null}

          <div>
            <Button
              type="button"
              className="h-11"
              disabled={confirmMutation.isPending || (requiresCause && cause === "")}
              onClick={() => confirmMutation.mutate()}
            >
              {confirmMutation.isPending ? "Cerrando…" : "Confirmar cierre"}
            </Button>
            <p className="pt-2 text-xs text-muted-foreground">
              El conteo ya quedó sellado en el paso 1: esto confirma la diferencia que viste, con su causa.
            </p>
          </div>
        </div>
      </TarjetaCierre>
    </div>
  );
}
