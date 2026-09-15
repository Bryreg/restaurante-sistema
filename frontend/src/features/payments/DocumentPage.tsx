import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";

import { useSession } from "@/app/session";
import { getDocument, reprintDocument, type DocumentPrintable } from "@/api/documents";
import { DIAN_STATUS_LABEL } from "@/api/fiscal";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

import "./document-print.css";

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  transfer: "Transferencia",
  platform: "Plataforma",
  voucher: "Bono",
  other: "Otro",
};

/** Texto SIEMPRE acompaña el color del `Badge` (nunca sólo color). */
function dianStatusLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  return (DIAN_STATUS_LABEL as Record<string, string>)[status] ?? status;
}

function dianBadgeVariant(status: string): "default" | "destructive" | "outline" {
  if (status === "validated") return "default";
  if (status === "rejected") return "destructive";
  return "outline";
}

function documentQueryKey(documentId: number) {
  return ["documents", documentId] as const;
}

/**
 * `/pos/documento/:documentId` (CONTRATO-INTERNO-1b-1.md §2.4 `GET
 * /documents/{id}` y §6.3 "Impresión"): representación gráfica del
 * comprobante interno con TODO lo que trae `DocumentPrintableOut` — la
 * leyenda (`legend`) se muestra tal cual llega, la propina va en una línea
 * aparte de la venta (SPEC-NEGOCIO §6.2). "Imprimir" es `window.print()` con
 * `document-print.css`; "Reimprimir" queda contado por el servidor
 * (`reprint_count`); "Volver" respeta `pos.tables`.
 */
export default function DocumentPage(): React.JSX.Element {
  const { documentId: documentIdParam } = useParams<{ documentId: string }>();
  const documentId = Number(documentIdParam);
  const navigate = useNavigate();
  const { hasFeature } = useSession();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: documentQueryKey(documentId),
    queryFn: () => getDocument(documentId),
    enabled: Number.isFinite(documentId),
  });

  const reprintMutation = useMutation({
    mutationFn: () => reprintDocument(documentId),
    onSuccess: (result) => {
      queryClient.setQueryData(documentQueryKey(documentId), result);
    },
  });

  function backTo() {
    navigate(hasFeature("pos.tables") ? "/pos/mesas" : "/pos/comanda/nueva");
  }

  if (!Number.isFinite(documentId)) {
    return <EmptyState role="alert" title="Comprobante inválido" />;
  }

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando el comprobante…</p>;
  }

  if (query.isError || !query.data) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo cargar el comprobante"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    );
  }

  const doc: DocumentPrintable = query.data;
  const store = doc.store;
  const customer = doc.customer;
  const order = doc.order;

  return (
    <div className="mx-auto max-w-md space-y-6 pb-16">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">Comprobante</h1>
          {doc.fiscal?.dian_status ? (
            <Badge variant={dianBadgeVariant(doc.fiscal.dian_status)}>{dianStatusLabel(doc.fiscal.dian_status)}</Badge>
          ) : null}
          {doc.fiscal?.contingency ? <Badge variant="outline">Contingencia</Badge> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="h-11" onClick={backTo}>
            Volver
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={reprintMutation.isPending}
            onClick={() => reprintMutation.mutate()}
          >
            {reprintMutation.isPending ? "Reimprimiendo…" : "Reimprimir"}
          </Button>
          <Button type="button" className="h-11" onClick={() => window.print()}>
            Imprimir
          </Button>
        </div>
      </div>

      {reprintMutation.isError ? (
        <p role="alert" className="text-sm text-destructive print:hidden">
          {errorMessage(reprintMutation.error)}
        </p>
      ) : null}

      <article id="document-printable" className="print-80mm space-y-3 rounded-md border p-4 text-sm">
        <header className="space-y-1 text-center">
          <p className="font-semibold">{store?.legal_name ?? "—"}</p>
          {store?.nit ? (
            <p className="text-xs text-muted-foreground">
              NIT {store.nit}
              {store.dv ? `-${store.dv}` : ""}
            </p>
          ) : null}
          {store?.address ? <p className="text-xs text-muted-foreground">{store.address}</p> : null}
          <p className="text-xs font-medium">{doc.type_label ?? doc.document_type}</p>
          <p className="text-sm font-semibold">{doc.full_number ?? `${doc.prefix ?? ""}-${doc.number ?? ""}`}</p>
        </header>

        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{doc.business_date ?? "—"}</span>
          <span>{doc.issued_at ? formatInstant(doc.issued_at) : "—"}</span>
        </div>

        {doc.fiscal?.dian_status || doc.fiscal?.cude || doc.fiscal?.qr_url ? (
          <div className="space-y-1 text-xs">
            {doc.fiscal?.dian_status ? (
              <p className="flex items-center justify-center gap-2">
                <span>Estado DIAN:</span>
                <Badge variant={dianBadgeVariant(doc.fiscal.dian_status)}>
                  {dianStatusLabel(doc.fiscal.dian_status)}
                </Badge>
              </p>
            ) : null}
            {doc.fiscal?.cude ? <p className="break-all text-center">CUDE: {doc.fiscal.cude}</p> : null}
            {doc.fiscal?.qr_url ? (
              <p className="break-all text-center">
                QR:{" "}
                <a className="underline" href={doc.fiscal.qr_url} target="_blank" rel="noreferrer">
                  {doc.fiscal.qr_url}
                </a>
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-0.5 text-xs">
          <p>Adquirente: {customer?.name ?? "Consumidor final"}</p>
          {customer?.doc_number ? (
            <p>
              {customer.doc_type ?? "Doc."}: {customer.doc_number}
            </p>
          ) : null}
        </div>

        <div className="space-y-0.5 text-xs">
          {order?.channel ? <p>Canal: {order.channel}</p> : null}
          {order?.tables && order.tables.length > 0 ? <p>Mesa(s): {order.tables.join(", ")}</p> : null}
          {order?.covers != null ? <p>Comensales: {order.covers}</p> : null}
          {order?.served_by ? <p>Atendió: {order.served_by}</p> : null}
          {order?.charged_by ? <p>Cobró: {order.charged_by}</p> : null}
        </div>

        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b text-left">
              <th className="py-1">Cant.</th>
              <th className="py-1">Descripción</th>
              <th className="py-1 text-right">Valor</th>
            </tr>
          </thead>
          <tbody>
            {(doc.lines ?? []).map((line, index) => (
              <tr key={index} className="border-b last:border-0">
                <td className="py-1 align-top">{line.qty ?? 1}</td>
                <td className="py-1 align-top">{line.description ?? "—"}</td>
                <td className="py-1 text-right align-top tabular-nums">{formatCOP(line.net)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="space-y-0.5 text-xs">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span className="tabular-nums">{formatCOP(doc.subtotal)}</span>
          </div>
          <div className="flex justify-between">
            <span>Descuentos</span>
            <span className="tabular-nums">{formatCOP(doc.discount_total)}</span>
          </div>
          {(doc.tax_lines ?? []).map((line, index) => (
            <div key={index} className="flex justify-between">
              <span>Impuesto {line.rate}%</span>
              <span className="tabular-nums">{formatCOP(line.tax)}</span>
            </div>
          ))}
          <div className="flex justify-between text-sm font-semibold">
            <span>Total</span>
            <span className="tabular-nums">{formatCOP(doc.total)}</span>
          </div>
        </div>

        {doc.tip ? (
          <div className="flex justify-between text-xs">
            <span>Propina voluntaria (sugerida {doc.tip.suggested_pct ?? 0}%)</span>
            <span className="tabular-nums">{formatCOP(doc.tip.amount)}</span>
          </div>
        ) : null}

        <div className="space-y-0.5 text-xs">
          {(doc.payments ?? []).map((payment, index) => (
            <div key={index} className="flex justify-between">
              <span>
                {payment.label ?? PAYMENT_METHOD_LABEL[payment.method ?? ""] ?? payment.method}
                {payment.dian_code ? ` (${payment.dian_code})` : ""}
              </span>
              <span className="tabular-nums">{formatCOP(payment.amount)}</span>
            </div>
          ))}
          {doc.change ? (
            <div className="flex justify-between">
              <span>Cambio</span>
              <span className="tabular-nums">{formatCOP(doc.change)}</span>
            </div>
          ) : null}
        </div>

        <p className="text-center text-xs font-medium uppercase">{doc.legend}</p>

        <p className="text-center text-[10px] text-muted-foreground">
          Copias impresas: {doc.print_count ?? 1} · Reimpresiones: {doc.reprint_count ?? 0}
        </p>
      </article>
    </div>
  );
}
