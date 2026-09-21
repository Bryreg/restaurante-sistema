import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, FileSearch, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useStoreSelection } from "@/app/storeContext";
import { newIdempotencyKey } from "@/api/client";
import {
  DIAN_STATUS_LABEL,
  DOCUMENT_TYPE_LABEL,
  fiscalDocumentsCsvUrl,
  fiscalExportUrl,
  getFiscalDocumentEvidence,
  listFiscalDocuments,
  retryFiscalDocument,
  type AdminFiscalDocumentOut,
  type DianStatus,
  type DocumentEvidenceOut,
  type FiscalDocumentType,
} from "@/api/fiscal";
import {
  DenseTable,
  DenseTableBar,
  FilterEmptyState,
  PageHeader,
  TimeAgo,
  type DenseColumn,
  type RowStatus,
} from "@/components/admin";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

import { LocalCsvExportButton, LocalDateRangeFilter } from "./components";

const STATUS_OPTIONS: DianStatus[] = ["pending", "sent", "validated", "rejected", "contingency"];

function statusBadgeVariant(status: DianStatus | null | undefined): "default" | "destructive" | "outline" {
  if (status === "validated") return "default";
  if (status === "rejected") return "destructive";
  return "outline";
}

function EvidenceDialog({ documentId, onOpenChange }: { documentId: number | null; onOpenChange: (open: boolean) => void }) {
  const query = useQuery<DocumentEvidenceOut>({
    queryKey: ["fiscal-document-evidence", documentId],
    queryFn: () => getFiscalDocumentEvidence(documentId as number),
    enabled: documentId !== null,
  });
  const evidence = query.data;

  return (
    <Dialog open={documentId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Evidencia — {evidence?.full_number ?? `#${documentId}`}</DialogTitle>
        </DialogHeader>
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : query.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(query.error)}
          </p>
        ) : evidence ? (
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground">Estado DIAN</dt>
              <dd>
                <Badge variant={statusBadgeVariant(evidence.dian_status as DianStatus | null)}>
                  {evidence.dian_status ? DIAN_STATUS_LABEL[evidence.dian_status as DianStatus] : "Sin transmitir"}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">CUDE</dt>
              <dd className="break-all">{evidence.cude ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">QR</dt>
              <dd className="break-all">
                {evidence.qr_url ? (
                  <a className="underline" href={evidence.qr_url} target="_blank" rel="noreferrer">
                    {evidence.qr_url}
                  </a>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">XML (referencia)</dt>
              <dd className="break-all">{evidence.xml_ref ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Validado</dt>
              <dd>{evidence.validated_at ? formatInstant(evidence.validated_at) : "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Hash del contenido (sha256)</dt>
              <dd className="break-all font-mono text-xs">{evidence.content_hash ?? "—"}</dd>
            </div>
            {evidence.range ? (
              <div>
                <dt className="text-muted-foreground">Rango que amparó el consecutivo</dt>
                <dd>
                  {evidence.range.prefix} ({evidence.range.from_number}–{evidence.range.to_number}) · resolución{" "}
                  {evidence.range.resolution_number}, vigente hasta {evidence.range.valid_until}
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-muted-foreground">Respuesta del proveedor / la DIAN</dt>
              <dd>
                <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs">
                  {evidence.provider_response ? JSON.stringify(evidence.provider_response, null, 2) : "—"}
                </pre>
              </dd>
            </div>
          </dl>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Admin → Documentos fiscales (SPEC-NEGOCIO §8.3, `spec.md` "API contract →
 * Payments & fiscal document"): estados ante la DIAN, reintento y evidencia.
 * El estado nunca se dice sólo por color: siempre lleva texto (`Badge` con
 * `DIAN_STATUS_LABEL`).
 */
/**
 * La franja de estado de la fila (patrón 8b): deja ver **la forma del
 * problema** sin leer. Rechazado y contingencia vencida son lo que hay que
 * atender; validado es lo que ya está cerrado; pendiente y enviado no son un
 * problema todavía, y por eso no se tiñen de nada.
 */
function estadoDeFila(row: AdminFiscalDocumentOut): RowStatus {
  if (row.dian_status === "rejected" || row.contingency_overdue) return "critical";
  if (row.dian_status === "contingency") return "warning";
  if (row.dian_status === "validated") return "ok";
  return "none";
}

/**
 * Admin → Documentos fiscales (SPEC-NEGOCIO §8.3, `spec.md` "API contract →
 * Payments & fiscal document"): estados ante la DIAN, reintento y evidencia.
 * El estado nunca se dice sólo por color: siempre lleva texto (`Badge` con
 * `DIAN_STATUS_LABEL`).
 */
export function DocumentsPage(): React.JSX.Element {
  const { activeStoreId, loading: storeLoading } = useStoreSelection();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<DianStatus | undefined>(undefined);
  const [typeFilter, setTypeFilter] = useState<FiscalDocumentType | undefined>(undefined);
  const [evidenceId, setEvidenceId] = useState<number | null>(null);
  const [exportRange, setExportRange] = useState({ from: "", to: "" });

  const query = useQuery({
    queryKey: ["fiscal-documents", activeStoreId, status],
    queryFn: () => listFiscalDocuments({ storeId: activeStoreId as number, status }),
    enabled: activeStoreId !== null,
  });

  const retryMutation = useMutation({
    mutationFn: (documentId: number) => retryFiscalDocument(documentId, newIdempotencyKey()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["fiscal-documents", activeStoreId] });
    },
  });

  if (storeLoading) {
    return <p className="text-sm text-muted-foreground">Cargando sedes…</p>;
  }
  if (activeStoreId === null) {
    return <p className="text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>;
  }

  const rows: AdminFiscalDocumentOut[] = query.data ?? [];
  // El servidor sólo filtra por `status` en esta ruta (ver `src/api/fiscal.ts`,
  // comentario de `listFiscalDocuments`); el filtro por tipo se aplica acá,
  // sobre las filas ya traídas — no es plata, es filtrar una lista.
  const filteredRows = typeFilter ? rows.filter((row) => row.document_type === typeFilter) : rows;

  // Los filtros puestos, **en palabras**: es lo que el vacío por filtro tiene
  // que nombrar para que el dueño sepa qué sacar (patrón 13).
  const filtrosPuestos: string[] = [];
  if (status) filtrosPuestos.push(DIAN_STATUS_LABEL[status]);
  if (typeFilter) filtrosPuestos.push(DOCUMENT_TYPE_LABEL[typeFilter]);

  function quitarFiltro(filtro: string) {
    if (status && DIAN_STATUS_LABEL[status] === filtro) setStatus(undefined);
    if (typeFilter && DOCUMENT_TYPE_LABEL[typeFilter] === filtro) setTypeFilter(undefined);
  }

  const porAtender = filteredRows.filter((row) => estadoDeFila(row) === "critical").length;

  const columns: readonly DenseColumn<AdminFiscalDocumentOut>[] = [
    {
      key: "number",
      header: "Documento",
      kind: "id",
      // Un número de documento es **una palabra sola**: nunca se parte.
      cell: (row) => row.full_number ?? `#${row.id}`,
    },
    {
      key: "type",
      header: "Tipo",
      // La celda escribe la palabra del negocio, no el enum.
      cell: (row) => (row.document_type ? DOCUMENT_TYPE_LABEL[row.document_type] : "—"),
    },
    {
      key: "status",
      header: "Estado ante la DIAN",
      cell: (row) => (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <Badge variant={statusBadgeVariant(row.dian_status)}>
            {row.dian_status ? DIAN_STATUS_LABEL[row.dian_status] : "Sin transmitir"}
          </Badge>
          {row.contingency_overdue ? <Badge variant="destructive">Contingencia vencida (48 h)</Badge> : null}
        </span>
      ),
    },
    {
      key: "date",
      header: "Emitido",
      kind: "secondary",
      widthPx: 96,
      // «hace 1 día» en la celda; el instante exacto, a un hover.
      cell: (row) => (row.issued_at ? <TimeAgo iso={row.issued_at} /> : (row.business_date ?? "—")),
      cellTitle: (row) => (row.issued_at ? formatInstant(row.issued_at) : undefined),
    },
    { key: "total", header: "Total", kind: "number", cell: (row) => formatCOP(row.total) },
    { key: "tip", header: "Propina", kind: "number", cell: (row) => formatCOP(row.tip_amount) },
    { key: "charged", header: "Cobró", kind: "secondary", cell: (row) => row.charged_by ?? "—" },
    { key: "customer", header: "Cliente", cell: (row) => row.customer_name ?? "Consumidor final" },
    {
      key: "actions",
      header: "",
      kind: "actions",
      // Íconos en columna de ancho fijo, como manda el patrón 8: tres botones
      // con texto se llevaban 104 px de más y hacían bailar el borde derecho
      // de fila en fila (la de un documento validado no lleva «Reintentar»).
      // El rótulo no se pierde: va en `aria-label` y en `title`, así que el
      // nombre accesible sigue siendo «Evidencia», «Reintentar», «Emitir nota».
      cell: (row) => (
        <span className="inline-flex items-center justify-end gap-0.5 whitespace-nowrap">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Evidencia"
            title="Evidencia: estado DIAN, CUDE, QR y el rango que amparó el consecutivo"
            onClick={() => setEvidenceId(row.id)}
          >
            <FileSearch className="size-4" aria-hidden="true" />
          </Button>
          {row.dian_status && row.dian_status !== "validated" ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Reintentar"
              title="Reintentar la transmisión a la DIAN"
              disabled={retryMutation.isPending}
              onClick={() => retryMutation.mutate(row.id)}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
            </Button>
          ) : (
            <span className="inline-block size-8" aria-hidden="true" />
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Emitir nota"
            title="Emitir una nota sobre este documento"
            render={<Link to={`/admin/fiscal/notas?document=${row.id}`} />}
          >
            <FilePlus2 className="size-4" aria-hidden="true" />
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        name="Documentos fiscales"
        question="¿Qué documento salió por cada cobro, en qué estado quedó ante la DIAN y qué evidencia hay si preguntan?"
        context={[
          { label: "Sede", value: "la activa", title: "El selector de sede vive en la lateral: alcanza a toda la app." },
          {
            label: "Sin flag: es ley",
            title: "El documento equivalente no se apaga desde Funciones; lo exige la Res. DIAN 000165/2023.",
          },
          { label: "Conservación", value: "5 años", title: "Por eso el paquete de evidencia lleva hash por documento." },
        ]}
        actions={<LocalCsvExportButton href={fiscalDocumentsCsvUrl({ storeId: activeStoreId, status })} />}
      />

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando documentos…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          reason="error"
          title="No se pudieron cargar los documentos"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (
        <DenseTable
          caption="Documentos fiscales emitidos por esta sede"
          columns={columns}
          rows={filteredRows}
          rowKey={(row) => String(row.id)}
          rowStatus={estadoDeFila}
          bar={
            <DenseTableBar
              shown={filteredRows.length}
              total={rows.length}
              noun="documentos"
              hidden={
                rows.length !== filteredRows.length
                  ? `${rows.length - filteredRows.length} ocultos por los filtros`
                  : porAtender > 0
                    ? `${porAtender} para atender`
                    : undefined
              }
            >
              <Label className="text-xs text-muted-foreground">Estado</Label>
              <Select
                value={status ?? "all"}
                onValueChange={(v) => setStatus(v === "all" ? undefined : (v as DianStatus))}
              >
                <SelectTrigger className="h-9 w-48" aria-label="Estado ante la DIAN">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {STATUS_OPTIONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {DIAN_STATUS_LABEL[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Label className="text-xs text-muted-foreground">Tipo</Label>
              <Select
                value={typeFilter ?? "all"}
                onValueChange={(v) => setTypeFilter(v === "all" ? undefined : (v as FiscalDocumentType))}
              >
                <SelectTrigger className="h-9 w-56" aria-label="Tipo de documento">
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  {Object.entries(DOCUMENT_TYPE_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DenseTableBar>
          }
          legend={[
            {
              term: "Sin transmitir no es rechazado",
              meaning:
                "lo primero es que todavía no salió hacia la DIAN y nadie dijo que estuviera mal; lo segundo es que la DIAN lo devolvió. Uno se reintenta, el otro se corrige.",
            },
            {
              term: "Contingencia vencida",
              meaning:
                "se emitió en contingencia y pasaron las 48 h para transmitirlo. El cobro fue válido; la transmisión ya no está a tiempo.",
            },
            {
              term: "El consecutivo no se libera",
              meaning:
                "un documento devuelto conserva su número. Toda corrección va por nota: el original se reversa, nunca se edita.",
            },
          ]}
          note="La propina viaja aparte del total imponible: no es venta del restaurante (Ley 1935 de 2018)."
          empty={
            filtrosPuestos.length > 0 ? (
              <FilterEmptyState
                title="Ningún documento coincide con estos filtros"
                filters={filtrosPuestos as [string, ...string[]]}
                totalWithoutFilters={rows.length > 0 ? rows.length : undefined}
                onRemove={quitarFiltro}
              />
            ) : (
              <EmptyState
                title="Ningún documento coincide con estos filtros"
                description="Todavía no hay documentos emitidos en esta sede."
              />
            )
          }
        />
      )}

      {retryMutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(retryMutation.error)}
        </p>
      ) : null}

      <section className="space-y-2 rounded-lg border bg-card p-3">
        <h2 className="text-sm font-bold">Exportar paquete de evidencia</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Manifiesto con hash por documento y hash del manifiesto entero, para conservación mínima de 5 años sin
          depender sólo del proveedor.
        </p>
        <LocalDateRangeFilter from={exportRange.from} to={exportRange.to} onChange={setExportRange} />
        {exportRange.from && exportRange.to ? (
          <LocalCsvExportButton
            href={fiscalExportUrl({ storeId: activeStoreId, from: exportRange.from, to: exportRange.to })}
            label="Exportar paquete de evidencia"
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            El botón aparece con las dos fechas puestas: un paquete sin rango no es evidencia de nada.
          </p>
        )}
      </section>

      <EvidenceDialog documentId={evidenceId} onOpenChange={(open) => !open && setEvidenceId(null)} />
    </div>
  );
}

export default DocumentsPage;
