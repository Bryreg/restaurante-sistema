import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { usePosTarea } from "@/app/posTarea";
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
import { formatClockTime } from "@/lib/businessDate";
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

/** «Mesa 4 · 3 comensales», o el canal y el número si no es de mesa. */
function orderTitle(order: OrderOut): string {
  const mesas = (order.tables ?? []).map((t) => t.number).join(", ");
  const partes = [mesas ? `Mesa ${mesas}` : `Comanda #${order.id}`];
  if (order.covers) partes.push(`${order.covers} ${order.covers === 1 ? "comensal" : "comensales"}`);
  return partes.join(" · ");
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
 * **Forma** (handoff `PosCobro`, tablet apaisada): a la izquierda, 440 px
 * con la cuenta —las líneas, «Consumo» con el impuesto incluido, la propina
 * en tres opciones y el libro con doble raya «Propina (no es venta)»—; a la
 * derecha, el cobro (`PaymentSplitsForm`). En vertical, una columna.
 *
 * Dividida (por asiento o por plato), las sub-cuentas son tarjetas
 * (`SplitPartsList`) que se cobran de arriba abajo, de a una: la que sigue
 * va resaltada («Cobrando») y se cobra a la derecha, con el rótulo «Parte 2
 * de 3 · a cobrar» y su monto del servidor.
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
  // pendiente de arriba abajo. Se cobra a la derecha, sin paso intermedio.
  const [activeSubAccountId, setActiveSubAccountId] = useState<number | null>(null);
  const [alreadyPaidNotice, setAlreadyPaidNotice] = useState(false);
  const [showLines, setShowLines] = useState(false);
  // Donde `PaymentTargetPanel` dibuja la propina y el libro: la columna de la cuenta.
  const [cuentaSlot, setCuentaSlot] = useState<HTMLDivElement | null>(null);

  // La cabecera del salón dice la tarea («Cobro · Mesa 4») y esconde las
  // secciones: el cobro tiene principio y fin, se sale con «← Comanda».
  const mesas = (order?.tables ?? []).map((t) => t.number).join(", ");
  usePosTarea({
    titulo: order ? `Cobro · ${mesas ? `Mesa ${mesas}` : `#${order.id}`}` : "Cobro",
    sinSecciones: true,
    aLoAncho: true,
  });

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
      // Dividida por asiento si todas las partes tienen su asiento.
      setSplitMode((order.sub_accounts ?? []).every((sa) => sa.seat != null) ? "seat" : "items");
      queryClient.setQueryData(subAccountsQueryKey(orderId), order.sub_accounts ?? []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  const subAccountsQuery = useQuery({
    queryKey: subAccountsQueryKey(orderId),
    queryFn: () => listSubAccounts(orderId),
    enabled: Number.isFinite(orderId) && (splitMode === "items" || splitMode === "seat"),
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
  // A-11 (`features/fase-1b-venta/outputs-1b-1/auditor-venta.md §3`): la
  // leyenda SIEMPRE sale del servidor, sin respaldo escrito a mano; si no
  // llegó, el bloque simplemente no se pinta (`preBill?.legend ? … : null`)
  // — en 1b-2 depende del estado DIAN y de la contingencia (SPEC-NEGOCIO
  // §8.3: las leyendas las define el emisor).
  const legend = preBill?.legend;

  const wholeOrderTarget: PaymentTarget = {
    totals: order.totals ?? {},
    tipInfo: preBill?.tip ?? order.tip,
  };

  const subMode = splitMode === "items" || splitMode === "seat";
  const pendingSubAccounts = subAccounts.filter((sa) => sa.status !== "paid");
  const activeSubAccount =
    pendingSubAccounts.find((sa) => sa.id === activeSubAccountId) ?? pendingSubAccounts[0] ?? null;
  const activeNumber = activeSubAccount ? (activeSubAccount.seq ?? subAccounts.indexOf(activeSubAccount) + 1) : null;
  const itemsById = new Map((order.items ?? []).map((item) => [item.id, item]));
  const splitParts: SplitPart[] = subAccounts.map((sa, index) => {
    const number = sa.seq ?? index + 1;
    const doc = sa.document_id != null ? documentById.get(sa.document_id) : undefined;
    const dishes = (sa.items ?? [])
      .map((line) => line.name ?? (line.item_id != null ? itemsById.get(line.item_id)?.name : undefined))
      .filter((name): name is string => Boolean(name));
    return {
      key: sa.id,
      number,
      label: customLabel(sa, number),
      amount: sa.totals?.total,
      state: sa.status === "paid" ? "paid" : sa.id === activeSubAccount?.id ? "active" : "pending",
      dishes: dishes.length > 0 ? dishes.join(", ") : null,
      // La propina de cada parte se pregunta al cobrarla; lo que se ve acá es
      // el sugerido que el servidor ya repartió para esa parte.
      detail:
        sa.status !== "paid" && sa.tip?.suggested_amount != null
          ? `Propina sugerida ${formatCOP(sa.tip.suggested_amount)}`
          : null,
      paidWith: paidWithText(doc),
      withInvoice: doc?.document_type === "invoice",
    };
  });
  const paidCount = subAccounts.length - pendingSubAccounts.length;

  // Las líneas de la cuenta: agrupadas por el servidor en la precuenta
  // («2× Limonada», montos sumados allá); sin precuenta, los ítems vivos con
  // su `net`. Acá sólo se pintan.
  const lines =
    preBill?.lines && preBill.lines.length > 0
      ? preBill.lines.map((line, index) => ({
          key: `p${index}`,
          qty: line.qty ?? 1,
          name: line.description ?? "Ítem",
          net: line.net,
        }))
      : items.map((item) => ({ key: `i${item.id}`, qty: item.qty ?? 1, name: item.name ?? "Ítem", net: item.net }));
  const taxLines = order.totals?.tax_lines ?? [];
  const taxName = items.some((item) => item.tax_code?.startsWith("iva")) ? "IVA" : "impuesto al consumo";
  const taxText =
    order.totals?.tax_total != null
      ? `Incluye ${taxName}${taxLines.length === 1 && taxLines[0]?.rate != null ? ` ${taxLines[0].rate} %` : ""} · ${formatCOP(order.totals.tax_total)}`
      : null;
  const seatsAvailable = hasFeature("pos.seats") && items.some((item) => item.seat != null);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:grid lg:grid-cols-[440px_minmax(0,1fr)] lg:overflow-hidden">
      <section aria-label="Cuenta" className="flex flex-col border-b bg-card lg:min-h-0 lg:border-r lg:border-b-0">
        <div className="flex items-center gap-2.5 border-b px-4 py-3">
          <Button
            type="button"
            variant="outline"
            className="h-[56px] shrink-0 gap-1.5 rounded-lg px-3.5 text-[16px] font-semibold [&_svg]:size-5"
            onClick={() => navigate(`/pos/comanda/${order.id}`)}
          >
            <ArrowLeft aria-hidden="true" />
            Comanda
          </Button>
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-[20px] leading-tight font-bold">{orderTitle(order)}</h1>
            <span className="truncate text-[14px] text-muted-foreground">
              {[
                order.opened_by?.name ? `Atendió ${order.opened_by.name}` : null,
                order.opened_at ? formatClockTime(order.opened_at) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2.5 px-4 py-2.5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {alreadyPaidNotice ? (
            <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
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

          {splitBillFlag ? (
            <SplitBillPanel
              orderId={order.id}
              expectedVersion={order.version ?? 1}
              items={items}
              mode={splitMode}
              seatsAvailable={seatsAvailable}
              hasParts={subMode && subAccounts.length > 0}
              locked={subMode && subAccounts.some((sa) => sa.status === "paid")}
              onModeChange={(mode) => {
                setSplitMode(mode);
                if (mode !== "equal") setEqualInitialSplits(undefined);
                if (mode !== "items" && mode !== "seat") setActiveSubAccountId(null);
              }}
              onItemsResult={(result: BillSplitItemsOut) => {
                queryClient.setQueryData(subAccountsQueryKey(orderId), result.sub_accounts ?? []);
                setActiveSubAccountId(null);
              }}
            />
          ) : null}

          {subMode ? (
            subAccounts.length > 0 ? (
              <SplitPartsList parts={splitParts} onSelect={(id) => setActiveSubAccountId(id)} />
            ) : null
          ) : (
            <div className="flex flex-col">
              {preBillFlag && presentBillMutation.isPending && !preBill ? (
                <p className="text-sm text-muted-foreground">Presentando la cuenta…</p>
              ) : null}
              {preBillFlag && presentBillMutation.isError && !preBill ? (
                <p role="alert" className="text-sm text-destructive">
                  {errorMessage(presentBillMutation.error)}
                </p>
              ) : null}
              {/* En vertical el detalle se pliega: el espacio es para lo
                  recibido y el PIN. En horizontal (440 px) se ve siempre. */}
              <button
                type="button"
                className="flex min-h-11 w-full items-center justify-between text-left text-[15px] font-medium lg:hidden"
                aria-expanded={showLines}
                onClick={() => setShowLines((v) => !v)}
              >
                <span>
                  Detalle de la cuenta · {lines.length} {lines.length === 1 ? "línea" : "líneas"}
                </span>
                <span aria-hidden="true">{showLines ? "▴" : "▾"}</span>
              </button>
              <ul aria-label="Detalle de la cuenta" className={cn(showLines ? "block" : "hidden lg:block")}>
                {lines.map((line) => (
                  <li key={line.key} className="flex gap-2.5 border-b border-dashed py-[7px] text-[16px]">
                    <b className="min-w-6">{line.qty}×</b>
                    <span className="flex-1">{line.name}</span>
                    <span className="tabular-nums">{formatCOP(line.net)}</span>
                  </li>
                ))}
              </ul>
              {order.totals?.discount_total ? (
                <div className="flex justify-between pt-2 text-[15px] text-muted-foreground">
                  <span>Descuentos</span>
                  <span className="tabular-nums">{formatCOP(order.totals.discount_total)}</span>
                </div>
              ) : null}
              <div className="flex justify-between pt-2.5 text-[17px] font-bold">
                <span>Consumo</span>
                <span className="tabular-nums">{formatCOP(order.totals?.total)}</span>
              </div>
              {taxText ? <p className="text-[13px] text-muted-foreground">{taxText}</p> : null}
              {legend ? (
                <p className="pt-2 text-center text-[12px] font-medium text-muted-foreground uppercase">{legend}</p>
              ) : null}
            </div>
          )}

          {/* La propina, las partes iguales y el libro con doble raya los
              dibuja `PaymentTargetPanel` acá (portal): son de la cuenta, a la
              izquierda, y el cobro queda a la derecha. */}
          <div ref={setCuentaSlot} className="mt-auto flex flex-col gap-2.5 pt-2" />

          {subMode && subAccounts.length > 0 ? (
            <p className="text-[15px] text-muted-foreground">
              {paidCount} de {subAccounts.length} {subAccounts.length === 1 ? "parte pagada" : "partes pagadas"}
            </p>
          ) : null}
        </div>
      </section>

      <section aria-label="Cobro" className="flex flex-col gap-3 px-[18px] py-3.5 lg:min-h-0 lg:overflow-y-auto">
        {subMode ? (
          activeSubAccount ? (
            <PaymentTargetPanel
              key={activeSubAccount.id}
              orderId={order.id}
              expectedVersion={order.version}
              target={{
                subAccountId: activeSubAccount.id,
                totals: activeSubAccount.totals ?? {},
                tipInfo: activeSubAccount.tip,
              }}
              tipsEnabled={tipsFlag}
              rotuloTotal={`Parte ${activeNumber} de ${subAccounts.length} · a cobrar`}
              cuentaSlot={cuentaSlot}
              onPaid={handlePaid}
              onStale={replaceWithFreshOrder}
              onAlreadyPaid={handleAlreadyPaid}
            />
          ) : (
            <p className="text-[15px] text-muted-foreground">
              {subAccounts.length > 0
                ? "Todas las partes están pagadas."
                : splitMode === "seat"
                  ? "Revisá los asientos a la izquierda y tocá «Dividir por asiento»."
                  : "Armá las cuentas a la izquierda y tocá «Dividir cuenta»."}
            </p>
          )
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
            cuentaSlot={cuentaSlot}
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
          />
        )}
      </section>
    </div>
  );
}
