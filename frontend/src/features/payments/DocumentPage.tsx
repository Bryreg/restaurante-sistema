import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Printer, Receipt, Scale } from "lucide-react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { useSession } from "@/app/session";
import { getDocument, reprintDocument, type DocumentPrintable } from "@/api/documents";
import { DIAN_STATUS_LABEL } from "@/api/fiscal";
import { Cargando } from "@/components/Cargando";
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

/** Un dato del encabezado del papel: rótulo a la izquierda, valor a la derecha. */
function Dato({ k, v }: { k: string; v: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-muted-foreground">{k}</span>
      <span className="min-w-0 text-right font-medium break-words">{v}</span>
    </div>
  );
}

/** Un renglón de totales del papel. `fuerte` es el que cierra el bloque. */
function Total({
  rotulo,
  detalle,
  valor,
  fuerte,
  className,
}: {
  rotulo: string;
  detalle?: string;
  valor: React.ReactNode;
  fuerte?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={`flex items-baseline justify-between gap-3 py-1 ${className ?? ""}`}>
      <span className="min-w-0">
        <span className={fuerte ? "font-bold" : undefined}>{rotulo}</span>
        {detalle ? <span className="block text-[0.85em] text-muted-foreground">{detalle}</span> : null}
      </span>
      <span
        className={`shrink-0 tabular-nums ${fuerte ? "text-base font-bold" : "font-medium"}`}
      >
        {valor}
      </span>
    </div>
  );
}

/**
 * `/pos/documento/:documentId` (CONTRATO-INTERNO-1b-1.md §2.4 `GET
 * /documents/{id}` y §6.3 "Impresión"): representación gráfica del
 * comprobante interno con TODO lo que trae `DocumentPrintableOut` — la
 * leyenda (`legend`) se muestra tal cual llega, la propina va en una línea
 * aparte de la venta (SPEC-NEGOCIO §6.2). "Imprimir" es `window.print()` con
 * `document-print.css`; "Reimprimir" queda contado por el servidor
 * (`reprint_count`); "Volver" respeta `pos.tables`.
 *
 * **Jerarquía (maqueta `m2b`, pestaña «Documento»)**: el papel angosto a la
 * izquierda, como la tira de 80 mm, y a la derecha las acciones y lo que el
 * papel dice. Adentro del papel, dos cosas mandan y no se pueden confundir:
 *
 * - el **impuesto va discriminado y no sumado** — su renglón vive ADENTRO
 *   del bloque de la venta, en tipo menor y con una regla propia, y el
 *   «Total venta» lo cierra: el impuesto ya está dentro de esa cifra
 *   (`app/orders/money.py::compute_totals` — `total = Σ net`, y el impuesto
 *   está dentro de cada `net`, se haya cotizado con o sin impuesto adentro);
 * - la **propina está fuera de la venta**: bloque aparte, después de la
 *   regla que cierra el total, nunca adentro de él (SPEC-NEGOCIO §6.2, Ley
 *   1935 de 2018).
 *
 * Qué datos se muestran no cambió: los mismos campos de
 * `DocumentPrintable`, ni uno más ni uno menos.
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

  // Viene del cobro de una parte y la cuenta todavía tiene partes sin cobrar
  // (`CheckoutPage.handlePaid`): «Volver» regresa a ese cobro.
  const seguirCobrando = (useLocation().state as { seguirCobrando?: number } | null)?.seguirCobrando;

  function backTo() {
    if (seguirCobrando) {
      navigate(`/pos/cobro/${seguirCobrando}`);
      return;
    }
    navigate(hasFeature("pos.tables") ? "/pos/mesas" : "/pos/comanda/nueva");
  }

  if (!Number.isFinite(documentId)) {
    return <EmptyState role="alert" title="Comprobante inválido" />;
  }

  if (query.isLoading) {
    return <Cargando texto="Cargando el comprobante…" />;
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
  const taxLines = doc.tax_lines ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 pb-16">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <h1 className="text-lg font-semibold">Comprobante</h1>
        <span className="text-lg font-semibold tabular-nums text-muted-foreground">
          Documento {doc.full_number ?? `${doc.prefix ?? ""}-${doc.number ?? ""}`}
        </span>
        {doc.fiscal?.dian_status ? (
          <Badge variant={dianBadgeVariant(doc.fiscal.dian_status)}>{dianStatusLabel(doc.fiscal.dian_status)}</Badge>
        ) : null}
        {doc.fiscal?.contingency ? <Badge variant="outline">Contingencia</Badge> : null}
      </div>

      {reprintMutation.isError ? (
        <p role="alert" className="text-sm text-destructive print:hidden">
          {errorMessage(reprintMutation.error)}
        </p>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[23rem_minmax(0,1fr)]">
        <div className="order-1 flex flex-col gap-4 lg:order-2 print:hidden">
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="h-11" onClick={() => window.print()}>
              <Printer aria-hidden="true" />
              Imprimir
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={reprintMutation.isPending}
              onClick={() => reprintMutation.mutate()}
            >
              <Receipt aria-hidden="true" />
              {reprintMutation.isPending ? "Reimprimiendo…" : "Reimprimir"}
            </Button>
            <Button type="button" variant={seguirCobrando ? "default" : "outline"} className="h-11" onClick={backTo}>
              <ArrowLeft aria-hidden="true" />
              {seguirCobrando ? "Seguir cobrando la mesa" : "Volver"}
            </Button>
          </div>

          {/* Plegada: se muestra en cada venta, y quien cobra ya la leyó. Se
              abre para explicarle el papel a un cliente que pregunta. */}
          <details className="group overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 bg-muted/60 px-4 py-2.5 text-muted-foreground [&::-webkit-details-marker]:hidden">
              <Scale aria-hidden="true" className="size-4" />
              <h2 className="text-xs font-bold tracking-wider uppercase">Qué dice este papel</h2>
              <span aria-hidden="true" className="ml-auto transition-transform group-open:rotate-180">
                ▾
              </span>
            </summary>
            <div className="grid gap-3 border-t px-4 py-3 text-sm leading-relaxed text-muted-foreground">
              <p>
                El <b className="text-foreground">impuesto va discriminado, no sumado</b>: su renglón está
                adentro del bloque de la venta y el «Total venta» ya lo incluye. No se agrega al final.
              </p>
              <p>
                La <b className="text-foreground">propina no es venta</b>: tiene su renglón afuera de la regla
                que cierra el total, y no paga impuesto al consumo.
              </p>
              <p>
                Cada copia la cuenta el servidor, con quién la pidió. El comprobante no cambia: cambia el
                contador del pie.
              </p>
            </div>
          </details>
        </div>

        <article
          id="document-printable"
          className="print-80mm order-2 rounded-md border bg-card p-4 text-sm lg:order-1"
        >
          <header className="space-y-0.5 text-center">
            <p className="text-base font-bold">{store?.legal_name ?? "—"}</p>
            {store?.nit ? (
              <p className="text-xs text-muted-foreground">
                NIT {store.nit}
                {store.dv ? `-${store.dv}` : ""}
              </p>
            ) : null}
            {store?.address ? <p className="text-xs text-muted-foreground">{store.address}</p> : null}
            <p className="pt-1 text-xs font-medium">{doc.type_label ?? doc.document_type}</p>
            <p className="text-base font-bold tracking-wide tabular-nums">
              {doc.full_number ?? `${doc.prefix ?? ""}-${doc.number ?? ""}`}
            </p>
          </header>

          <div className="mt-3 border-t border-dashed pt-2 text-xs">
            <Dato k="Fecha" v={doc.business_date ?? "—"} />
            <Dato k="Emitido" v={doc.issued_at ? formatInstant(doc.issued_at) : "—"} />
            <Dato k="Adquirente" v={customer?.name ?? "Consumidor final"} />
            {/* El adquirente genérico de la DIAN («222222222222») no se
                repite: «Consumidor final» ya lo dice. Un cliente identificado
                muestra su tipo de documento en palabras («C.C.», «NIT»). */}
            {customer?.doc_number && !customer.final_consumer ? (
              <Dato k={customer.doc_type_label ?? customer.doc_type ?? "Doc."} v={customer.doc_number} />
            ) : null}
          </div>

          {order?.channel || (order?.tables && order.tables.length > 0) || order?.covers != null || order?.served_by || order?.charged_by ? (
            <div className="mt-2 border-t border-dashed pt-2 text-xs">
              {order?.channel ? <Dato k="Canal" v={order.channel_label ?? order.channel} /> : null}
              {order?.tables && order.tables.length > 0 ? <Dato k="Mesa(s)" v={order.tables.join(", ")} /> : null}
              {order?.covers != null ? <Dato k="Comensales" v={order.covers} /> : null}
              {order?.served_by ? <Dato k="Atendió" v={order.served_by} /> : null}
              {order?.charged_by ? <Dato k="Cobró" v={order.charged_by} /> : null}
            </div>
          ) : null}

          <table className="mt-3 w-full border-collapse border-t border-dashed text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-1 font-medium">Cant.</th>
                <th className="py-1 font-medium">Descripción</th>
                <th className="py-1 text-right font-medium">Valor</th>
              </tr>
            </thead>
            <tbody>
              {(doc.lines ?? []).map((line, index) => (
                <tr key={index} className="border-b last:border-0">
                  <td className="py-1 pr-2 align-top tabular-nums">{line.qty ?? 1}</td>
                  <td className="py-1 align-top">{line.description ?? "—"}</td>
                  <td className="py-1 text-right align-top font-medium tabular-nums">{formatCOP(line.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* LA VENTA. El impuesto vive adentro de este bloque, en tipo
              menor y sangrado: se discrimina, no se suma. El «Total venta»
              cierra el bloque con la regla gruesa — lo que viene después ya
              no es venta. */}
          <div className="mt-3 border-t border-dashed pt-2 text-xs">
            <Total rotulo="Subtotal" valor={formatCOP(doc.subtotal)} />
            <Total rotulo="Descuentos" valor={formatCOP(doc.discount_total)} />

            <div className="my-1 border-l-2 border-border py-0.5 pl-2.5">
              {taxLines.map((line, index) => (
                <Total key={index} rotulo={`Impuesto ${line.rate}%`} valor={formatCOP(line.tax)} />
              ))}
              <p className="pt-0.5 text-[0.85em] leading-snug text-muted-foreground">
                Discriminado, no sumado: ya está adentro del total de venta.
              </p>
            </div>

            <Total
              rotulo="Total venta"
              valor={formatCOP(doc.total)}
              fuerte
              className="mt-1 border-t-2 border-foreground pt-1.5"
            />
          </div>

          {/* LA PROPINA. Afuera de la regla que cierra la venta: no es venta,
              no paga impuesto y no entra en el total de arriba. */}
          {doc.tip ? (
            <div className="mt-2 rounded-md border-l-2 border-foreground bg-muted px-2.5 py-1.5 text-xs print:bg-transparent">
              <Total
                rotulo={`Propina voluntaria (sugerida ${doc.tip.suggested_pct ?? 0}%)`}
                valor={formatCOP(doc.tip.amount)}
              />
              <p className="text-[0.85em] leading-snug text-muted-foreground">
                Va aparte de la venta: no entra en el total de venta ni paga impuesto al consumo.
              </p>
            </div>
          ) : null}

          <div className="mt-3 border-t border-dashed pt-2 text-xs">
            <p className="pb-0.5 font-medium text-muted-foreground">Pagos</p>
            {(doc.payments ?? []).map((payment, index) => (
              <Dato
                key={index}
                k={`${payment.label ?? PAYMENT_METHOD_LABEL[payment.method ?? ""] ?? payment.method}${
                  payment.dian_code ? ` (${payment.dian_code})` : ""
                }`}
                v={<span className="tabular-nums">{formatCOP(payment.amount)}</span>}
              />
            ))}
            {doc.change ? <Dato k="Cambio" v={<span className="tabular-nums">{formatCOP(doc.change)}</span>} /> : null}
          </div>

          {doc.fiscal?.dian_status || doc.fiscal?.cude || doc.fiscal?.qr_url ? (
            <div className="mt-3 space-y-1 border-t border-dashed pt-2 text-xs">
              {doc.fiscal?.dian_status ? (
                <p className="flex items-center justify-center gap-2">
                  <span>Estado DIAN:</span>
                  <Badge variant={dianBadgeVariant(doc.fiscal.dian_status)}>
                    {dianStatusLabel(doc.fiscal.dian_status)}
                  </Badge>
                </p>
              ) : null}
              {doc.fiscal?.cude ? (
                <p className="text-center">
                  <span className="block text-muted-foreground">CUDE</span>
                  <span className="break-all">{doc.fiscal.cude}</span>
                </p>
              ) : null}
              {doc.fiscal?.qr_url ? (
                <p className="text-center">
                  <span className="block text-muted-foreground">QR</span>
                  <a className="break-all underline" href={doc.fiscal.qr_url} target="_blank" rel="noreferrer">
                    {doc.fiscal.qr_url}
                  </a>
                </p>
              ) : null}
            </div>
          ) : null}

          <p className="mt-3 border-t border-dashed pt-2 text-center text-xs font-medium uppercase">{doc.legend}</p>

          <p className="pt-1 text-center text-[10px] text-muted-foreground">
            Copias impresas: {doc.print_count ?? 1} · Reimpresiones: {doc.reprint_count ?? 0}
          </p>
        </article>
      </div>
    </div>
  );
}
