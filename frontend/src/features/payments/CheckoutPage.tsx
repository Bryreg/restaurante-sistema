import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useSession } from "@/app/session";
import { newIdempotencyKey } from "@/api/client";
import { getLastDocument } from "@/api/documents";
import {
  getOrder,
  listSubAccounts,
  presentBill,
  type BillSplitEqualOut,
  type BillSplitItemsOut,
  type OrderOut,
  type PreBillOut,
} from "@/api/orders";
import type { PaymentOut } from "@/api/payments";
import { EmptyState } from "@/components/EmptyState";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

import type { InitialSplit } from "./PaymentSplitsForm";
import type { PaymentTarget } from "./PaymentTargetPanel";
import { PaymentTargetPanel } from "./PaymentTargetPanel";
import { SplitBillPanel, type SplitBillMode } from "./SplitBillPanel";

function orderQueryKey(orderId: number) {
  return ["orders", orderId] as const;
}

function subAccountsQueryKey(orderId: number) {
  return ["orders", orderId, "sub-accounts"] as const;
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
  const [activeSubAccountId, setActiveSubAccountId] = useState<number | null>(null);
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
  const subAccounts = subAccountsQuery.data ?? [];

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
      navigate(`/pos/documento/${documentId}`, { replace: true });
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
    return <p className="text-sm text-muted-foreground">Cargando la comanda…</p>;
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

  const activeSubAccount = subAccounts.find((sa) => sa.id === activeSubAccountId) ?? null;
  const subAccountTarget: PaymentTarget | null = activeSubAccount
    ? { subAccountId: activeSubAccount.id, totals: activeSubAccount.totals ?? {}, tipInfo: activeSubAccount.tip }
    : null;

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
          onModeChange={(mode) => {
            setSplitMode(mode);
            if (mode !== "equal") setEqualInitialSplits(undefined);
            if (mode !== "items") setActiveSubAccountId(null);
          }}
          onEqualResult={(result: BillSplitEqualOut) => {
            setEqualInitialSplits((result.per_part ?? []).map((amount) => ({ method: "cash" as const, amount })));
          }}
          onItemsResult={(result: BillSplitItemsOut) => {
            queryClient.setQueryData(subAccountsQueryKey(orderId), result.sub_accounts ?? []);
            setActiveSubAccountId(null);
          }}
        />
      ) : null}

      {splitMode === "items" ? (
        subAccounts.length > 0 ? (
          <div className="space-y-2">
            {subAccounts.map((sa) => (
              <div key={sa.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">{sa.label ?? `Cuenta ${sa.seq ?? sa.id}`}</p>
                  <p className="text-xs text-muted-foreground">
                    {sa.status === "paid" ? "Cobrada" : formatCOP(sa.totals?.total)}
                  </p>
                </div>
                {sa.status !== "paid" ? (
                  <button
                    type="button"
                    className="h-11 rounded-md border px-4 text-sm font-medium"
                    onClick={() => setActiveSubAccountId(sa.id)}
                  >
                    Cobrar
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Armá las cuentas arriba y tocá «Dividir cuenta».</p>
        )
      ) : null}

      {splitMode === "items" ? (
        subAccountTarget ? (
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
