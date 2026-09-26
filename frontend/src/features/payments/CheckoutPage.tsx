import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useSession } from "@/app/session";
import { newIdempotencyKey } from "@/api/client";
import { getDocument, getLastDocument, type DocumentPrintable } from "@/api/documents";
import {
  getOrder,
  listSubAccounts,
  presentBill,
  type BillSplitEqualOut,
  type BillSplitItemsOut,
  type OrderOut,
  type PreBillOut,
  type SubAccountOut,
} from "@/api/orders";
import { PAYMENT_METHOD_LABEL, type PaymentMethod, type PaymentOut } from "@/api/payments";
import { Cargando } from "@/components/Cargando";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";
import { cn } from "@/lib/utils";

import type { InitialSplit } from "./PaymentSplitsForm";
import type { PaymentTarget } from "./PaymentTargetPanel";
import { PaymentTargetPanel } from "./PaymentTargetPanel";
import { EqualSplitPicker, SplitBillPanel, SplitPartsList, type SplitBillMode, type SplitPart } from "./SplitBillPanel";

function orderQueryKey(orderId: number) {
  return ["orders", orderId] as const;
}

function subAccountsQueryKey(orderId: number) {
  return ["orders", orderId, "sub-accounts"] as const;
}

/** Misma clave que `DocumentPage`: el comprobante que se abre después ya está en caché. */
function documentQueryKey(documentId: number) {
  return ["documents", documentId] as const;
}

/** Con qué se pagó una parte, en palabras: «Efectivo», «Tarjeta + Efectivo». */
function paidWithText(doc: DocumentPrintable | undefined): string | null {
  const medios = (doc?.payments ?? [])
    .map((p) => p.label || PAYMENT_METHOD_LABEL[p.method as PaymentMethod] || p.method)
    .filter((m): m is string => Boolean(m));
  return medios.length > 0 ? [...new Set(medios)].join(" + ") : null;
}

/** El nombre de fábrica de una sub-cuenta («Cuenta 3») no suma nada al lado de «Parte 3». */
function customLabel(sa: SubAccountOut, number: number): string | null {
  const label = sa.label?.trim();
  if (!label || label === `Cuenta ${number}` || label === `Cuenta ${sa.seq ?? number}`) return null;
  return label;
}

/**
 * `/pos/cobro/:orderId` (SPEC-NEGOCIO §9.1 "Cuenta y cobro";
 * CONTRATO-INTERNO-1b-1.md §6.2 y §7 — territorio de `frontend-cobro`). Ruta
 * de `paymentsFeature`, dueña `src/app/router.tsx`.
 *
 * Flujo: carga la comanda (`getOrder`, sondeo 5 s); si `pos.pre_bill` está
 * encendida, presenta la cuenta una vez y muestra la precuenta con su
 * leyenda tal cual llega; pregunta de propina si `pos.tips` está encendida;
 * si `pos.split_bill` está encendida, ofrece partes iguales o por ítems;
 * cobra con `PaymentTargetPanel` (comanda entera o una sub-cuenta) y, con el
 * documento que vuelve, navega a `/pos/documento/:id`.
 *
 * Dividida por ítems, las sub-cuentas son filas numeradas (`SplitPartsList`)
 * que se cobran de arriba abajo, de a una: la que sigue va resaltada y el
 * botón principal la nombra con su monto («Cobrar parte 3 · $41.800»).
 */
export default function CheckoutPage(): React.JSX.Element {
  const { orderId: orderIdParam } = useParams<{ orderId: string }>();
  const orderId = Number(orderIdParam);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { hasFeature } = useSession();

  const preBillFlag = hasFeature("pos.pre_bill");
  const splitBillFlag = hasFeature("pos.split_bill");
  const tipsFlag = hasFeature("pos.tips");

  const orderQuery = useQuery({
    queryKey: orderQueryKey(orderId),
    queryFn: () => getOrder(orderId),
    enabled: Number.isFinite(orderId),
    refetchInterval: 5_000,
  });
  const order = orderQuery.data;

  const [preBill, setPreBill] = useState<PreBillOut | null>(null);
  const [splitMode, setSplitMode] = useState<SplitBillMode>("none");
  const [equalInitialSplits, setEqualInitialSplits] = useState<InitialSplit[] | undefined>(undefined);
  // La parte que sigue: la que eligió la cajera o, si no eligió, la primera
  // pendiente de arriba abajo. `chargingSubAccountId` = ya tocó «Cobrar
  // parte N» y se ve la tabla de pagos de esa parte.
  const [activeSubAccountId, setActiveSubAccountId] = useState<number | null>(null);
  const [chargingSubAccountId, setChargingSubAccountId] = useState<number | null>(null);
  const [alreadyPaidNotice, setAlreadyPaidNotice] = useState(false);
  const [showLines, setShowLines] = useState(false);
  // Donde `PaymentSplitsForm` dibuja el cierre del cobro (ver abajo).
  const [confirmSlot, setConfirmSlot] = useState<HTMLDivElement | null>(null);

  const presentedForOrderRef = useRef<number | null>(null);
  const presentBillIdempotencyRef = useRef(newIdempotencyKey());
  const autoSplitModeRef = useRef<number | null>(null);

  const presentBillMutation = useMutation({
    mutationFn: (version: number) =>
      presentBill(orderId, { expected_version: version }, presentBillIdempotencyRef.current),
    onSuccess: (result) => {
      setPreBill(result);
      void queryClient.invalidateQueries({ queryKey: orderQueryKey(orderId) });
    },
    onError: () => {
      presentBillIdempotencyRef.current = newIdempotencyKey();
    },
  });

  // Al entrar con `pos.pre_bill` encendida, presenta la cuenta una sola vez
  // por comanda (aunque el sondeo refresque `order` de nuevo): es el "pasa
  // por precuenta" de la navegación acordada, sin sumar un toque extra.
  useEffect(() => {
    if (!preBillFlag || !order) return;
    if (presentedForOrderRef.current === order.id) return;
    presentedForOrderRef.current = order.id;
    presentBillMutation.mutate(order.version ?? 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preBillFlag, order?.id]);

  // Si la comanda ya venía con una división por ítems (se volvió a esta
  // pantalla, o se armó desde otro lado), retoma esa división en vez de
  // ofrecer "cobrar todo junto" sobre ítems que ya están en sub-cuentas.
  useEffect(() => {
    if (!order || order.id === autoSplitModeRef.current) return;
    if ((order.sub_accounts ?? []).length > 0) {
      autoSplitModeRef.current = order.id;
      setSplitMode("items");
      queryClient.setQueryData(subAccountsQueryKey(orderId), order.sub_accounts ?? []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  const subAccountsQuery = useQuery({
    queryKey: subAccountsQueryKey(orderId),
    queryFn: () => listSubAccounts(orderId),
    enabled: Number.isFinite(orderId) && splitMode === "items",
  });
  const subAccounts = [...(subAccountsQuery.data ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  // Medio y factura de cada parte cobrada: `SubAccountOut` sólo trae
  // `document_id`; el comprobante (`GET /documents/{id}`) dice con qué se
  // pagó y si salió como factura electrónica. Un comprobante no cambia: se
  // pide una vez.
  const paidDocumentIds = subAccounts
    .filter((sa) => sa.status === "paid" && sa.document_id != null)
    .map((sa) => sa.document_id as number);
  const paidDocuments = useQueries({
    queries: paidDocumentIds.map((id) => ({
      queryKey: documentQueryKey(id),
      queryFn: () => getDocument(id),
      staleTime: Infinity,
    })),
  });
  const documentById = new Map<number, DocumentPrintable>();
  paidDocumentIds.forEach((id, index) => {
    const doc = paidDocuments[index]?.data;
    if (doc) documentById.set(id, doc);
  });

  function replaceWithFreshOrder(next: OrderOut) {
    queryClient.setQueryData(orderQueryKey(orderId), next);
    void queryClient.invalidateQueries({ queryKey: orderQueryKey(orderId) });
  }

  function handlePaid(result: PaymentOut) {
    if (result.order) {
      replaceWithFreshOrder(result.order);
    }
    void queryClient.invalidateQueries({ queryKey: subAccountsQueryKey(orderId) });
    const documentId = result.document?.id;
    if (documentId) {
      // Se cobró una parte y la comanda sigue sin pagar: quedan partes. El
      // comprobante ofrece volver acá en vez de mandar a Mesas, que obligaba
      // a buscar la mesa de nuevo con la fila esperando.
      const quedanPartes =
        result.sub_account_id !== null && result.sub_account_id !== undefined && result.order?.status !== "paid";
      navigate(`/pos/documento/${documentId}`, {
        replace: true,
        state: quedanPartes ? { seguirCobrando: orderId } : undefined,
      });
      return;
    }
    // Total 0 (staff_meal o todo cortesía): no se emite documento.
    navigate(hasFeature("pos.tables") ? "/pos/mesas" : "/pos/comanda/nueva", { replace: true });
  }

  function handleAlreadyPaid() {
    setAlreadyPaidNotice(true);
    void queryClient.invalidateQueries({ queryKey: orderQueryKey(orderId) });
  }

  async function goToLastDocument() {
    try {
      const last = await getLastDocument();
      if (last) {
        navigate(`/pos/documento/${last.id}`);
      }
    } catch {
      // Se queda en la pantalla; el aviso de "ya cobrada" sigue visible.
    }
  }

  if (!Number.isFinite(orderId)) {
    return <EmptyState role="alert" title="Comanda inválida" />;
  }

  if (orderQuery.isLoading) {
    return <Cargando texto="Cargando la comanda…" />;
  }

  if (orderQuery.isError || !order) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo cargar la comanda"
        description={errorMessage(orderQuery.error)}
        action={{ label: "Reintentar", onClick: () => void orderQuery.refetch() }}
      />
    );
  }

  if (order.status === "paid") {
    return (
      <div className="space-y-4">
        <EmptyState title="Esta comanda ya fue cobrada" description="Consultá el comprobante." />
        {order.document_id ? (
          <div className="flex justify-center">
            <button
              type="button"
              className="h-11 rounded-md border px-4 text-sm font-medium"
              onClick={() => navigate(`/pos/documento/${order.document_id}`)}
            >
              Ver comprobante
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (order.status === "voided" || order.status === "merged") {
    return <EmptyState role="alert" title="Esta comanda no está disponible para cobro" />;
  }

  const items = (order.items ?? []).filter((item) => item.status !== "voided");
  // A-11 (`features/fase-1b-venta/outputs-1b-1/auditor-venta.md §3`): antes
  // de este pedido acá había `preBill?.legend ?? "NO ES FACTURA — documento
  // informativo"`, un respaldo escrito a mano que se mostraba INCLUSO
  // cuando `preBill` todavía era `null` (mientras `bill/present` viajaba o
  // había fallado) — el POS afirmaba algo que el servidor no dijo. En
  // 1b-2 la leyenda depende del estado DIAN y de la contingencia
  // (`app/fiscal/service.py`), así que un texto hardcodeado pasó de
  // prolijidad a riesgo legal (SPEC-NEGOCIO §8.3: las leyendas las define
  // el emisor). Ahora la leyenda SIEMPRE sale del servidor, sin respaldo;
  // si no llegó, el bloque simplemente no se pinta más abajo
  // (`preBill?.legend ? … : null`) — mismo patrón que ya usaba
  // `DocumentPage.tsx` (`{doc.legend}`, sin alternativa).
  const legend = preBill?.legend;

  const wholeOrderTarget: PaymentTarget = {
    totals: order.totals ?? {},
    tipInfo: preBill?.tip ?? order.tip,
  };

  const pendingSubAccounts = subAccounts.filter((sa) => sa.status !== "paid");
  const activeSubAccount =
    pendingSubAccounts.find((sa) => sa.id === activeSubAccountId) ?? pendingSubAccounts[0] ?? null;
  const activeNumber = activeSubAccount ? (activeSubAccount.seq ?? subAccounts.indexOf(activeSubAccount) + 1) : null;
  const activeTotal = activeSubAccount?.totals?.total;
  const subAccountTarget: PaymentTarget | null =
    activeSubAccount && chargingSubAccountId === activeSubAccount.id
      ? { subAccountId: activeSubAccount.id, totals: activeSubAccount.totals ?? {}, tipInfo: activeSubAccount.tip }
      : null;
  const splitParts: SplitPart[] = subAccounts.map((sa, index) => {
    const number = sa.seq ?? index + 1;
    const doc = sa.document_id != null ? documentById.get(sa.document_id) : undefined;
    return {
      key: sa.id,
      number,
      label: customLabel(sa, number),
      amount: sa.totals?.total,
      state: sa.status === "paid" ? "paid" : sa.id === activeSubAccount?.id ? "active" : "pending",
      paidWith: paidWithText(doc),
      withInvoice: doc?.document_type === "invoice",
    };
  });

  const lineCount = preBill?.lines?.length ?? 0;

  return (
    <div className="mx-auto max-w-6xl pb-6">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-lg font-semibold">Cuenta y cobro</h1>
        <p className="text-sm text-muted-foreground">Comanda #{order.id}</p>
      </div>

      {alreadyPaidNotice ? (
        <div className="mb-3 space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p role="alert" className="text-sm font-medium text-destructive">
            Esta comanda ya fue cobrada.
          </p>
          <button
            type="button"
            className="h-11 rounded-md border px-4 text-sm font-medium"
            onClick={() => void goToLastDocument()}
          >
            Ver el último comprobante
          </button>
        </div>
      ) : null}

      {/* Tablet horizontal: la cuenta y lo recibido a la izquierda, el cierre
          (estado, vuelto, quién cobra y el PIN) fijo a la derecha. Vertical:
          una columna compacta, con el PIN al final pero sin pliegue. */}
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-6">
        <div className="min-w-0 space-y-3">
          {/* El total manda: grande y primero, porque es lo que se le dice a
              la mesa. El desglose va chico al lado, para quien lo pregunte. */}
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 rounded-xl bg-card px-4 py-3 ring-1 ring-border">
            <div>
              <p className="text-sm text-muted-foreground">Total de la cuenta</p>
              <p className="text-4xl leading-tight font-extrabold tabular-nums" style={{ fontStretch: "115%" }}>
                {formatCOP(order.totals?.total)}
              </p>
            </div>
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tabular-nums">{formatCOP(order.totals?.subtotal)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Descuentos</dt>
                <dd className="tabular-nums">{formatCOP(order.totals?.discount_total)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Impuesto</dt>
                <dd className="tabular-nums">{formatCOP(order.totals?.tax_total)}</dd>
              </div>
            </dl>
          </div>

          {preBillFlag ? (
            <div className="space-y-2 rounded-md border px-3 py-2">
              {presentBillMutation.isPending && !preBill ? (
                <p className="text-sm text-muted-foreground">Presentando la cuenta…</p>
              ) : null}
              {presentBillMutation.isError && !preBill ? (
                <p role="alert" className="text-sm text-destructive">
                  {errorMessage(presentBillMutation.error)}
                </p>
              ) : null}
              {lineCount > 0 ? (
                <>
                  {/* En vertical el detalle se pliega: el espacio es para lo
                      recibido y el PIN. En horizontal se ve siempre. */}
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center justify-between text-left text-sm font-medium lg:hidden"
                    aria-expanded={showLines}
                    onClick={() => setShowLines((v) => !v)}
                  >
                    <span>Detalle de la cuenta · {lineCount} {lineCount === 1 ? "línea" : "líneas"}</span>
                    <span aria-hidden="true">{showLines ? "▴" : "▾"}</span>
                  </button>
                  {/* Las líneas llegan ya agrupadas del servidor («2× Limonada»),
                      con sus montos sumados allá: acá sólo se pintan. */}
                  <div className={cn("max-h-48 space-y-1 overflow-y-auto text-sm", showLines ? "block" : "hidden lg:block")}>
                    {preBill?.lines?.map((line, index) => (
                      <div key={index} className="flex justify-between gap-2">
                        <span>
                          {line.qty ?? 1}× {line.description ?? "Ítem"}
                        </span>
                        <span className="tabular-nums">{formatCOP(line.net)}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
              {legend ? (
                <p className="text-center text-xs font-medium uppercase text-muted-foreground">{legend}</p>
              ) : null}
            </div>
          ) : null}

          {splitBillFlag ? (
            <SplitBillPanel
              orderId={order.id}
              expectedVersion={order.version ?? 1}
              items={items}
              mode={splitMode}
              hasParts={splitMode === "items" && subAccounts.length > 0}
              locked={splitMode === "items" && subAccounts.some((sa) => sa.status === "paid")}
              onModeChange={(mode) => {
                setSplitMode(mode);
                if (mode !== "equal") setEqualInitialSplits(undefined);
                if (mode !== "items") {
                  setActiveSubAccountId(null);
                  setChargingSubAccountId(null);
                }
              }}
              onItemsResult={(result: BillSplitItemsOut) => {
                queryClient.setQueryData(subAccountsQueryKey(orderId), result.sub_accounts ?? []);
                setActiveSubAccountId(null);
                setChargingSubAccountId(null);
              }}
            />
          ) : null}

          {splitMode === "items" ? (
            subAccounts.length > 0 ? (
              <div className="space-y-3">
                <SplitPartsList
                  parts={splitParts}
                  onSelect={(id) => {
                    setActiveSubAccountId(id);
                    setChargingSubAccountId(null);
                  }}
                />
                {/* Una acción principal, abajo y a lo ancho, que repite la parte
                    y el monto (del servidor): «Cobrar parte 3 · $41.800». */}
                {activeSubAccount && chargingSubAccountId !== activeSubAccount.id ? (
                  <Button
                    type="button"
                    className="min-h-14 w-full text-lg font-semibold"
                    onClick={() => setChargingSubAccountId(activeSubAccount.id)}
                  >
                    {`Cobrar parte ${activeNumber}${activeTotal != null ? ` · ${formatCOP(activeTotal)}` : ""}`}
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Armá las cuentas arriba y tocá «Dividir cuenta».</p>
            )
          ) : null}

          {splitMode === "items" ? (
            subAccountTarget ? (
              <div className="space-y-2">
                <h2 className="text-base font-semibold">
                  Parte {activeNumber} · {formatCOP(activeTotal)}
                </h2>
                <PaymentTargetPanel
                  key={subAccountTarget.subAccountId}
                  orderId={order.id}
                  expectedVersion={order.version}
                  target={subAccountTarget}
                  tipsEnabled={tipsFlag}
                  onPaid={handlePaid}
                  onStale={replaceWithFreshOrder}
                  onAlreadyPaid={handleAlreadyPaid}
                  confirmSlot={confirmSlot}
                />
              </div>
            ) : null
          ) : (
            // Una sola instancia para «todo junto» y «partes iguales»: la
            // propina se responde UNA vez y sobrevive al cambio de modo. Lo
            // que se vuelve a sembrar al dividir es sólo la tabla de pagos.
            <PaymentTargetPanel
              key="whole"
              orderId={order.id}
              expectedVersion={order.version}
              target={wholeOrderTarget}
              tipsEnabled={tipsFlag}
              initialSplits={splitMode === "equal" ? equalInitialSplits : undefined}
              splitsKey={
                splitMode === "equal" && equalInitialSplits
                  ? `equal-${equalInitialSplits.map((s) => s.amount).join("-")}`
                  : "whole"
              }
              beforePayments={
                splitMode === "equal"
                  ? (tip) => (
                      <EqualSplitPicker
                        orderId={order.id}
                        expectedVersion={order.version ?? 1}
                        tipAmount={tip?.amount}
                        onResult={(result: BillSplitEqualOut) => {
                          // Lo que paga cada parte, venta + propina, del
                          // servidor (`per_part_due`); `per_part` sólo si el
                          // servidor no lo mandó.
                          const due =
                            result.per_part_due && result.per_part_due.length > 0
                              ? result.per_part_due
                              : (result.per_part ?? []);
                          setEqualInitialSplits(due.map((amount) => ({ method: "cash" as const, amount })));
                          // Dividir sube la versión de la comanda: se relee
                          // antes de cobrar para no chocar con un 409.
                          void queryClient.invalidateQueries({ queryKey: orderQueryKey(orderId) });
                        }}
                        onStale={() => void queryClient.invalidateQueries({ queryKey: orderQueryKey(orderId) })}
                      />
                    )
                  : undefined
              }
              onPaid={handlePaid}
              onStale={replaceWithFreshOrder}
              onAlreadyPaid={handleAlreadyPaid}
              confirmSlot={confirmSlot}
            />
          )}
        </div>

        {/* El cierre del cobro lo dibuja `PaymentSplitsForm` acá adentro
            (portal): en horizontal queda fijo a la derecha y siempre a la
            vista; en vertical, al final de la columna. */}
        <div ref={setConfirmSlot} className="min-w-0 lg:sticky lg:top-3" />
      </div>
    </div>
  );
}
