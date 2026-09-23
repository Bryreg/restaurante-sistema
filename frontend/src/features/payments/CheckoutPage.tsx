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

import type { InitialSplit } from "./PaymentSplitsForm";
import type { PaymentTarget } from "./PaymentTargetPanel";
import { PaymentTargetPanel } from "./PaymentTargetPanel";
import { SplitBillPanel, SplitPartsList, type SplitBillMode, type SplitPart } from "./SplitBillPanel";

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

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-12">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Cuenta y cobro</h1>
        <p className="text-sm text-muted-foreground">Comanda #{order.id}</p>
      </div>

      {alreadyPaidNotice ? (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
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

      {preBillFlag ? (
        <div className="space-y-3 rounded-md border p-4">
          {presentBillMutation.isPending && !preBill ? (
            <p className="text-sm text-muted-foreground">Presentando la cuenta…</p>
          ) : null}
          {presentBillMutation.isError && !preBill ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(presentBillMutation.error)}
            </p>
          ) : null}
          {preBill?.lines ? (
            <div className="space-y-1 text-sm">
              {preBill.lines.map((line, index) => (
                <div key={index} className="flex justify-between gap-2">
                  <span>
                    {line.qty ?? 1}× {line.description ?? "Ítem"}
                  </span>
                  <span className="tabular-nums">{formatCOP(line.net)}</span>
                </div>
              ))}
            </div>
          ) : null}
          {legend ? (
            <p className="text-center text-xs font-medium uppercase text-muted-foreground">{legend}</p>
          ) : null}
        </div>
      ) : null}

      {/* El total manda: grande y primero, porque es lo que se le dice a la
          mesa. El desglose va chico debajo, para quien lo pregunte. */}
      <div className="rounded-xl bg-card p-4 ring-1 ring-border">
        <p className="text-sm text-muted-foreground">Total de la cuenta</p>
        <p
          className="text-4xl leading-tight font-extrabold tabular-nums sm:text-5xl"
          style={{ fontStretch: "115%" }}
        >
          {formatCOP(order.totals?.total)}
        </p>
        <dl className="mt-3 grid grid-cols-3 gap-2 border-t pt-3 text-sm">
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
          onEqualResult={(result: BillSplitEqualOut) => {
            setEqualInitialSplits((result.per_part ?? []).map((amount) => ({ method: "cash" as const, amount })));
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
            />
          </div>
        ) : null
      ) : (
        <PaymentTargetPanel
          key={splitMode === "equal" ? `equal-${equalInitialSplits?.length ?? 0}` : "whole"}
          orderId={order.id}
          expectedVersion={order.version}
          target={wholeOrderTarget}
          tipsEnabled={tipsFlag}
          initialSplits={splitMode === "equal" ? equalInitialSplits : undefined}
          onPaid={handlePaid}
          onStale={replaceWithFreshOrder}
          onAlreadyPaid={handleAlreadyPaid}
        />
      )}
    </div>
  );
}
