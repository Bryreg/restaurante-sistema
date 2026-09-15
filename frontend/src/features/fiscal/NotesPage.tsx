import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useStoreSelection } from "@/app/storeContext";
import { newIdempotencyKey } from "@/api/client";
import { getDocument } from "@/api/documents";
import {
  DOCUMENT_TYPE_LABEL,
  createNote,
  listNotes,
  notesCsvUrl,
  type AdminNoteListItem,
  type NoteCreateIn,
  type NoteKind,
} from "@/api/fiscal";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";
import { formatCOP } from "@/lib/money";

import { LocalCsvExportButton, LocalDateRangeFilter } from "./components";

const KIND_BY_ORIGINAL_TYPE: Record<string, NoteKind[]> = {
  pos_equivalent: ["adjustment"],
  invoice: ["credit", "debit"],
};

const KIND_LABEL: Record<NoteKind, string> = {
  adjustment: "Nota de ajuste",
  credit: "Nota crédito",
  debit: "Nota débito",
};

function NewNoteForm({
  initialDocumentId,
  onCreated,
}: {
  initialDocumentId: number | null;
  onCreated: () => void;
}) {
  const [documentIdInput, setDocumentIdInput] = useState(initialDocumentId != null ? String(initialDocumentId) : "");
  const [lookupId, setLookupId] = useState<number | null>(initialDocumentId);
  const [kind, setKind] = useState<NoteKind | "">("");
  const [reason, setReason] = useState("");
  const [usedItemIds, setUsedItemIds] = useState<Set<number>>(new Set());
  const [refundEnabled, setRefundEnabled] = useState(false);
  const [refundMethod, setRefundMethod] = useState("cash");
  const [refundAmount, setRefundAmount] = useState("");

  const docQuery = useQuery({
    queryKey: ["fiscal-note-source-document", lookupId],
    queryFn: () => getDocument(lookupId as number),
    enabled: lookupId !== null,
  });
  const original = docQuery.data;
  const allowedKinds = original?.document_type ? (KIND_BY_ORIGINAL_TYPE[original.document_type] ?? []) : [];
  const lines = (original?.lines ?? []).filter((line): line is typeof line & { item_id: number } => line.item_id != null);

  const mutation = useMutation({
    mutationFn: () => {
      if (lookupId === null || kind === "") {
        throw new Error("Elegí el documento y el tipo de nota antes de continuar.");
      }
      const body: NoteCreateIn = {
        kind,
        reason: reason.trim(),
        lines: lines.map((line) => ({ item_id: line.item_id, used: usedItemIds.has(line.item_id) })),
        refund: refundEnabled && refundAmount !== "" ? { method: refundMethod, amount: Number(refundAmount) } : undefined,
      };
      return createNote(lookupId, body, newIdempotencyKey());
    },
    onSuccess: () => {
      setDocumentIdInput("");
      setLookupId(null);
      setKind("");
      setReason("");
      setUsedItemIds(new Set());
      setRefundEnabled(false);
      setRefundAmount("");
      onCreated();
    },
  });

  const canSubmit = lookupId !== null && kind !== "" && reason.trim() !== "" && usedItemIds.size > 0;

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div>
        <h2 className="text-sm font-semibold">Nueva nota</h2>
        <p className="text-sm text-muted-foreground">
          Toda corrección va por nota. El documento original queda <strong>reversado</strong>, nunca editado ni
          borrado.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="note-document-id">Documento original (ID)</Label>
          <Input
            id="note-document-id"
            className="h-11 w-40"
            inputMode="numeric"
            value={documentIdInput}
            onChange={(e) => setDocumentIdInput(e.target.value)}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={() => {
            const id = Number(documentIdInput);
            setLookupId(Number.isFinite(id) && id > 0 ? id : null);
            setKind("");
            setUsedItemIds(new Set());
          }}
        >
          Buscar
        </Button>
      </div>

      {docQuery.isLoading ? <p className="text-sm text-muted-foreground">Buscando el documento…</p> : null}
      {docQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(docQuery.error)}
        </p>
      ) : null}

      {original ? (
        <div className="space-y-3">
          <p className="text-sm">
            {original.full_number ?? `#${original.id}`} · {original.document_type ? DOCUMENT_TYPE_LABEL[original.document_type as keyof typeof DOCUMENT_TYPE_LABEL] : "—"} ·{" "}
            {formatCOP(original.total)}
          </p>

          {allowedKinds.length === 0 ? (
            <p role="alert" className="text-sm text-destructive">
              Este tipo de documento no admite notas (sólo documento equivalente POS o factura electrónica).
            </p>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="note-kind">Tipo de nota</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as NoteKind)}>
                <SelectTrigger id="note-kind" className="h-11 w-56">
                  <SelectValue placeholder="Elegí el tipo" />
                </SelectTrigger>
                <SelectContent>
                  {allowedKinds.map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="note-reason">Motivo</Label>
            <Textarea id="note-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>

          <div className="space-y-1">
            <Label>Líneas que corrige la nota</Label>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead />
                    <TableHead>Descripción</TableHead>
                    <TableHead>Cant.</TableHead>
                    <TableHead>Neto</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => (
                    <TableRow key={line.item_id}>
                      <TableCell>
                        <Checkbox
                          aria-label={`Incluir ${line.description ?? "ítem"} en la nota`}
                          checked={usedItemIds.has(line.item_id)}
                          onCheckedChange={(checked) =>
                            setUsedItemIds((prev) => {
                              const next = new Set(prev);
                              if (checked) next.add(line.item_id);
                              else next.delete(line.item_id);
                              return next;
                            })
                          }
                        />
                      </TableCell>
                      <TableCell>{line.description ?? "—"}</TableCell>
                      <TableCell>{line.qty ?? 1}</TableCell>
                      <TableCell className="tabular-nums">{formatCOP(line.net)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="note-refund-enabled"
                checked={refundEnabled}
                onCheckedChange={(checked) => setRefundEnabled(checked === true)}
              />
              <Label htmlFor="note-refund-enabled">Devolver plata al cliente</Label>
            </div>
            {refundEnabled ? (
              <div className="flex flex-wrap gap-3">
                <div className="space-y-1">
                  <Label htmlFor="note-refund-method">Medio</Label>
                  <Select value={refundMethod} onValueChange={(v) => setRefundMethod(v ?? "cash")}>
                    <SelectTrigger id="note-refund-method" className="h-11 w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cash">Efectivo</SelectItem>
                      <SelectItem value="card">Tarjeta</SelectItem>
                      <SelectItem value="transfer">Transferencia</SelectItem>
                      <SelectItem value="other">Otro</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="note-refund-amount">Monto</Label>
                  <Input
                    id="note-refund-amount"
                    type="number"
                    min={0}
                    className="h-11 w-40"
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                  />
                </div>
                <p className="max-w-xs self-end text-xs text-muted-foreground">
                  En efectivo: sale del turno abierto; sin turno abierto queda como devolución pendiente.
                </p>
              </div>
            ) : null}
          </div>

          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}

          <Button type="button" className="h-11" disabled={!canSubmit || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Emitiendo…" : "Emitir nota"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Admin → Documentos fiscales → Notas (SPEC-NEGOCIO §3.5, §6.3; `spec.md`
 * "API contract → Payments & fiscal document"): `GET /admin/notes`,
 * `POST /admin/documents/{id}/notes`. `?document=<id>` (llegado desde
 * "Emitir nota" en `DocumentsPage`) prellena el documento a corregir.
 */
export function NotesPage(): React.JSX.Element {
  const { activeStoreId, loading: storeLoading } = useStoreSelection();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [range, setRange] = useState({ from: "", to: "" });

  const initialDocumentIdParam = searchParams.get("document");
  const initialDocumentId = initialDocumentIdParam ? Number(initialDocumentIdParam) : null;

  const query = useQuery({
    queryKey: ["fiscal-notes", activeStoreId, range],
    queryFn: () =>
      listNotes({ storeId: activeStoreId as number, from: range.from || undefined, to: range.to || undefined }),
    enabled: activeStoreId !== null,
  });

  if (storeLoading) {
    return <p className="text-sm text-muted-foreground">Cargando sedes…</p>;
  }
  if (activeStoreId === null) {
    return <p className="text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>;
  }

  const rows: AdminNoteListItem[] = query.data ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Notas</h1>
        <p className="text-sm text-muted-foreground">
          Ajuste, crédito y débito — cada una con su propio consecutivo, en su propio rango.
        </p>
      </div>

      <NewNoteForm
        initialDocumentId={initialDocumentId}
        onCreated={() => void queryClient.invalidateQueries({ queryKey: ["fiscal-notes", activeStoreId] })}
      />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <LocalDateRangeFilter from={range.from} to={range.to} onChange={setRange} />
        <LocalCsvExportButton href={notesCsvUrl({ storeId: activeStoreId, from: range.from || undefined, to: range.to || undefined })} />
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando notas…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudieron cargar las notas" description={errorMessage(query.error)} />
      ) : rows.length === 0 ? (
        <EmptyState title="Todavía no hay notas en este período" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Corrige</TableHead>
                <TableHead>Motivo</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Fecha</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((note) => (
                <TableRow key={note.id}>
                  <TableCell>{note.full_number ?? note.id}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{note.document_type ? DOCUMENT_TYPE_LABEL[note.document_type] : "—"}</Badge>
                  </TableCell>
                  <TableCell>Documento #{note.reverses_document_id} (reversado)</TableCell>
                  <TableCell>{note.reason ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{formatCOP(note.total)}</TableCell>
                  <TableCell>{note.issued_at ? formatInstant(note.issued_at) : (note.business_date ?? "—")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export default NotesPage;
