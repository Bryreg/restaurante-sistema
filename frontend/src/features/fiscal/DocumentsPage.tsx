import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Documentos fiscales</h1>
          <p className="text-sm text-muted-foreground">
            Estado ante la DIAN, reintento y evidencia. Un documento rechazado nunca libera su consecutivo.
          </p>
        </div>
        <LocalCsvExportButton href={fiscalDocumentsCsvUrl({ storeId: activeStoreId, status })} />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label>Estado</Label>
          <Select value={status ?? "all"} onValueChange={(v) => setStatus(v === "all" ? undefined : (v as DianStatus))}>
            <SelectTrigger className="h-10 w-48" aria-label="Estado ante la DIAN">
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
        </div>
        <div className="space-y-1">
          <Label>Tipo</Label>
          <Select
            value={typeFilter ?? "all"}
            onValueChange={(v) => setTypeFilter(v === "all" ? undefined : (v as FiscalDocumentType))}
          >
            <SelectTrigger className="h-10 w-56" aria-label="Tipo de documento">
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
        </div>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando documentos…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudieron cargar los documentos" description={errorMessage(query.error)} />
      ) : filteredRows.length === 0 ? (
        <EmptyState title="Ningún documento coincide con estos filtros" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Propina</TableHead>
                <TableHead>Cobró</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredRows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.full_number ?? row.id}</TableCell>
                  <TableCell>{row.document_type ? DOCUMENT_TYPE_LABEL[row.document_type] : "—"}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant={statusBadgeVariant(row.dian_status)}>
                        {row.dian_status ? DIAN_STATUS_LABEL[row.dian_status] : "Sin transmitir"}
                      </Badge>
                      {row.contingency_overdue ? <Badge variant="destructive">Contingencia vencida (48 h)</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell>{row.issued_at ? formatInstant(row.issued_at) : (row.business_date ?? "—")}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(row.total)}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(row.tip_amount)}</TableCell>
                  <TableCell>{row.charged_by ?? "—"}</TableCell>
                  <TableCell>{row.customer_name ?? "Consumidor final"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button type="button" variant="outline" className="h-9" onClick={() => setEvidenceId(row.id)}>
                        Evidencia
                      </Button>
                      {row.dian_status && row.dian_status !== "validated" ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="h-9"
                          disabled={retryMutation.isPending}
                          onClick={() => retryMutation.mutate(row.id)}
                        >
                          Reintentar
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9"
                        render={<Link to={`/admin/fiscal/notas?document=${row.id}`} />}
                      >
                        Emitir nota
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {retryMutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(retryMutation.error)}
        </p>
      ) : null}

      <div className="space-y-2 rounded-md border p-4">
        <h2 className="text-sm font-semibold">Exportar paquete de evidencia</h2>
        <p className="text-xs text-muted-foreground">
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
          <p className="text-xs text-muted-foreground">Elegí "desde" y "hasta" para exportar.</p>
        )}
      </div>

      <EvidenceDialog documentId={evidenceId} onOpenChange={(open) => !open && setEvidenceId(null)} />
    </div>
  );
}

export default DocumentsPage;
