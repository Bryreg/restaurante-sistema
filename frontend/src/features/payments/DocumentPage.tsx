import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Printer, Receipt, Scale, ShieldCheck } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";

import { useSession } from "@/app/session";
import { getDocument, reprintDocument, type DocumentPrintable } from "@/api/documents";
import { DIAN_STATUS_LABEL } from "@/api/fiscal";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { formatBusinessDate, formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";
import { CHANNEL_LABEL } from "@/features/orders/lib";

import "./document-print.css";

/**
 * Tipo de documento del adquirente. `customer.doc_type` viaja como **código
 * DIAN** («13» cédula, «31» NIT…), y ese código se estaba imprimiendo como
 * rótulo: el papel entregado al cliente decía «13  22222222222». Es una
 * etiqueta de interfaz, igual que `DIAN_STATUS_LABEL`, no la leyenda legal
 * —ésa sigue saliendo entera del servidor en `doc.legend`—.
 */
const DOC_TYPE_LABEL: Record<string, string> = {
  "11": "Registro civil",
  "12": "Tarjeta de identidad",
  "13": "Cédula",
  "21": "Tarjeta de extranjería",
  "22": "Cédula de extranjería",
  "31": "NIT",
  "41": "Pasaporte",
  "42": "Documento extranjero",
  "47": "PEP",
  "50": "NIT de otro país",
};

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

/**
 * Un renglón de las tarjetas de la derecha: rótulo con su explicación chica
 * a la izquierda, dato a la derecha. La explicación no es adorno — es lo que
 * convierte «POS-CH-008157» en «el consecutivo corre derecho».
 */
function Medio({
  rotulo,
  ayuda,
  valor,
}: {
  rotulo: string;
  ayuda?: string;
  valor: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <dt className="min-w-0">
        {rotulo}
        {ayuda ? <small className="block text-xs text-muted-foreground">{ayuda}</small> : null}
      </dt>
      <dd className="ml-auto text-right font-medium tabular-nums">{valor}</dd>
    </div>
  );
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
  const taxLines = doc.tax_lines ?? [];
  const numero = doc.full_number ?? `${doc.prefix ?? ""}-${doc.number ?? ""}`;
  // «Comprobante de la mesa 7» (`m2b`), con el mismo criterio que la Comanda
  // y el Cobro: primero de quién es, no el número interno.
  const mesas = (order?.tables ?? []).join(", ");
  const titulo = mesas ? `Comprobante de la mesa ${mesas}` : "Comprobante";
  const rango = doc.fiscal?.range;
  const reimpresiones = doc.reprints ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 pb-16">
      {/* **La cabecera de `m2b`** (pantalla 4). «Se le cobró» arriba de la
          cifra, y debajo de qué se compone: es la pregunta que hace el
          cliente al recibir el papel, y la que el mesero no debería tener
          que resolver sumando de cabeza. */}
      <header className="flex flex-wrap items-start gap-4 rounded-xl border bg-muted px-4 py-3 print:hidden">
        <div className="min-w-0">
          <h1 className="text-xl leading-tight font-semibold">{titulo}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {doc.type_label ?? doc.document_type}{" "}
            <b className="text-foreground tabular-nums">{numero}</b>
            {doc.issued_at ? ` · emitido a las ${formatInstant(doc.issued_at)}` : null}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {doc.fiscal?.dian_status ? (
              <Badge variant={dianBadgeVariant(doc.fiscal.dian_status)}>
                {dianStatusLabel(doc.fiscal.dian_status)}
              </Badge>
            ) : null}
            {doc.fiscal?.contingency ? <Badge variant="outline">Contingencia</Badge> : null}
          </div>
        </div>
        <div className="ml-auto text-right">
          <span className="block text-xs text-muted-foreground">Se le cobró</span>
          <span className="block text-[1.75rem] leading-tight font-bold tabular-nums">
            {formatCOP(doc.amount_paid)}
          </span>
          {doc.tip?.amount ? (
            <span className="block text-xs text-muted-foreground tabular-nums">
              Venta {formatCOP(doc.total)} + propina {formatCOP(doc.tip.amount)}
            </span>
          ) : null}
        </div>
      </header>

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
              Imprimir de nuevo
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={reprintMutation.isPending}
              onClick={() => reprintMutation.mutate()}
            >
              <Receipt aria-hidden="true" />
              {reprintMutation.isPending ? "Reimprimiendo…" : "Copia para el cliente"}
            </Button>
            <Button type="button" variant="outline" className="h-11" onClick={backTo}>
              <ArrowLeft aria-hidden="true" />
              Volver al salón
            </Button>
          </div>

          {/* **«Numeración y estado»** (`m2b`). Lo que contesta la pregunta
              incómoda de una auditoría: que el consecutivo corre derecho, de
              qué resolución sale y cuántos quedan. Todo lo dice el servidor;
              acá no se resta ni un número. */}
          {rango ? (
            <section className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
              <div className="flex items-center gap-2 border-b bg-muted/60 px-4 py-2.5 text-muted-foreground">
                <ShieldCheck aria-hidden="true" className="size-4" />
                <h2 className="text-xs font-bold tracking-wider uppercase">Numeración y estado</h2>
                {doc.fiscal?.dian_status ? (
                  <Badge className="ml-auto" variant={dianBadgeVariant(doc.fiscal.dian_status)}>
                    {dianStatusLabel(doc.fiscal.dian_status)}
                  </Badge>
                ) : null}
              </div>
              <dl className="divide-y text-sm">
                <Medio
                  rotulo="Consecutivo"
                  ayuda="Corre derecho: ningún número se salta ni se repite"
                  valor={numero}
                />
                <Medio
                  rotulo="Rango autorizado"
                  ayuda={`Resolución ${rango.resolution_number ?? "—"}`}
                  valor={
                    rango.prefix && rango.from_number != null && rango.to_number != null
                      ? `${rango.prefix} ${rango.from_number} a ${rango.to_number}`
                      : "—"
                  }
                />
                {rango.remaining != null ? (
                  <Medio
                    rotulo="Quedan"
                    ayuda={rango.valid_until ? `El rango vence el ${formatBusinessDate(rango.valid_until)}` : undefined}
                    valor={`${rango.remaining.toLocaleString("es-CO")} ${rango.remaining === 1 ? "número" : "números"}`}
                  />
                ) : null}
              </dl>
              <p className="border-t px-4 py-3 text-sm leading-relaxed text-muted-foreground">
                La leyenda del pie llega ya redactada del servidor y la tablet la imprime tal cual. Acá no se arma
                texto legal.
              </p>
            </section>
          ) : null}

          {/* **«Impresiones»** (`m2b`). El comprobante no cambia al
              reimprimirse: cambia el contador, y cada copia queda con quién
              la pidió y a qué hora. */}
          <section className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
            <div className="flex items-center gap-2 border-b bg-muted/60 px-4 py-2.5 text-muted-foreground">
              <Printer aria-hidden="true" className="size-4" />
              <h2 className="text-xs font-bold tracking-wider uppercase">Impresiones</h2>
              <span className="ml-auto text-xs">
                {doc.print_count ?? 1} {(doc.print_count ?? 1) === 1 ? "original" : "originales"} ·{" "}
                {reimpresiones.length} {reimpresiones.length === 1 ? "reimpresión" : "reimpresiones"}
              </span>
            </div>
            <dl className="divide-y text-sm">
              <Medio
                rotulo="Original"
                ayuda={order?.charged_by ?? undefined}
                valor={doc.issued_at ? formatInstant(doc.issued_at) : "—"}
              />
              {reimpresiones.map((copia, index) => (
                <Medio
                  key={index}
                  rotulo={`Copia ${index + 1}`}
                  ayuda={copia.by ?? undefined}
                  valor={copia.at ? formatInstant(copia.at) : "—"}
                />
              ))}
            </dl>
            {reimpresiones.length === 0 ? (
              <p className="border-t px-4 py-3 text-sm leading-relaxed text-muted-foreground">
                Todavía no se reimprimió. Cada copia queda contada por el servidor, con quién la pidió y a qué hora.
              </p>
            ) : null}
          </section>

          <section className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
            <div className="flex items-center gap-2 border-b bg-muted/60 px-4 py-2.5 text-muted-foreground">
              <Scale aria-hidden="true" className="size-4" />
              <h2 className="text-xs font-bold tracking-wider uppercase">Qué dice este papel</h2>
            </div>
            <div className="grid gap-3 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
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
          </section>
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
            {customer?.doc_number ? (
              <Dato
                k={customer.doc_type ? (DOC_TYPE_LABEL[customer.doc_type] ?? "Identificación") : "Identificación"}
                v={customer.doc_number}
              />
            ) : null}
          </div>

          {order?.channel || (order?.tables && order.tables.length > 0) || order?.covers != null || order?.served_by || order?.charged_by ? (
            <div className="mt-2 border-t border-dashed pt-2 text-xs">
              {/* `CHANNEL_LABEL` es el mismo diccionario que usa el salón:
                  el papel decía «dine_in», que es el nombre interno del
                  canal y no significa nada para quien lo recibe. */}
              {order?.channel ? <Dato k="Canal" v={CHANNEL_LABEL[order.channel] ?? order.channel} /> : null}
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
                <div key={index}>
                  <Total rotulo="Base gravable" valor={formatCOP(line.base)} />
                  <p className="text-[0.85em] leading-snug text-muted-foreground">El precio sin el impuesto</p>
                  <Total rotulo={`Impuesto al consumo ${line.rate}%`} valor={formatCOP(line.tax)} />
                  <p className="text-[0.85em] leading-snug text-muted-foreground">
                    Ya venía adentro del precio de la carta
                  </p>
                </div>
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

          {doc.tip?.amount ? (
            <div className="mt-2 border-t-2 border-foreground pt-1.5 text-xs">
              <Total rotulo="Total pagado" valor={formatCOP(doc.amount_paid)} fuerte />
              <p className="text-[0.85em] leading-snug text-muted-foreground tabular-nums">
                {formatCOP(doc.total)} de venta + {formatCOP(doc.tip.amount)} de propina
              </p>
            </div>
          ) : null}

          <div className="mt-3 border-t border-dashed pt-2 text-xs">
            <p className="pb-0.5 font-medium text-muted-foreground">Pagos</p>
            {/* Cada medio con SU parte de propina en renglón propio, cuando
                la tiene. Sin ese renglón el papel cerraba en «Total pagado
                $108.167» y abajo listaba «Efectivo $99.000»: al cliente le
                faltaban $9.167 y no había dónde encontrarlos. No se suman
                las dos cifras acá — se muestran las dos, que es además la
                regla del producto: la propina nunca se mezcla con la venta. */}
            {(doc.payments ?? []).map((payment, index) => {
              const rotulo = `${payment.label ?? PAYMENT_METHOD_LABEL[payment.method ?? ""] ?? payment.method}${
                payment.dian_code ? ` (${payment.dian_code})` : ""
              }`;
              return (
                <div key={index}>
                  <Dato k={rotulo} v={<span className="tabular-nums">{formatCOP(payment.amount)}</span>} />
                  {payment.tip_amount ? (
                    <Dato
                      k={`${rotulo} · propina`}
                      v={<span className="tabular-nums">{formatCOP(payment.tip_amount)}</span>}
                    />
                  ) : null}
                  {payment.tendered ? (
                    <Dato k="Recibido" v={<span className="tabular-nums">{formatCOP(payment.tendered)}</span>} />
                  ) : null}
                </div>
              );
            })}
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
