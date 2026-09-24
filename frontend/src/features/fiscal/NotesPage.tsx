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
import { Cargando } from "@/components/Cargando";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DenseTable,
  DenseTableBar,
  FilterEmptyState,
  FormSection,
  OriginBar,
  PageHeader,
  TimeAgo,
  type DenseColumn,
} from "@/components/admin";
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
  // Elección explícita por línea tildada: `true` vuelve al inventario,
  // `false` se usó (no vuelve), `undefined` = todavía sin elegir. Nunca
  // preseleccionado (B-1, ronda 2): que nadie devuelva un plato por default
  // sin decidirlo.
  const [returnsToStock, setReturnsToStock] = useState<Record<number, boolean>>({});
  const [refundEnabled, setRefundEnabled] = useState(false);
  const [refundMethod, setRefundMethod] = useState("cash");
  const [refundAmount, setRefundAmount] = useState("");
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const isDebit = kind === "debit";

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
        lines: lines.map((line) => {
          const included = usedItemIds.has(line.item_id);
          return {
            item_id: line.item_id,
            used: included,
            // Nota débito: cobra más, no devuelve producto — `false` en
            // TODAS las líneas, tildadas o no. Fuera de débito: sólo las
            // líneas tildadas tienen una elección real; las no tildadas no
            // son parte de la nota y van en `false` sin pedirle nada al
            // usuario.
            returns_to_stock: isDebit ? false : included ? (returnsToStock[line.item_id] ?? false) : false,
          };
        }),
        refund: refundEnabled && refundAmount !== "" ? { method: refundMethod, amount: Number(refundAmount) } : undefined,
      };
      return createNote(lookupId, body, newIdempotencyKey());
    },
    onSuccess: (note) => {
      const returnedIds = note.returned_to_stock_item_ids ?? [];
      setConfirmation(
        returnedIds.length === 0
          ? "Ningún ítem volvió al inventario."
          : returnedIds.length === 1
            ? "1 ítem volvió al inventario."
            : `${returnedIds.length} ítems volvieron al inventario.`,
      );
      setDocumentIdInput("");
      setLookupId(null);
      setKind("");
      setReason("");
      setUsedItemIds(new Set());
      setReturnsToStock({});
      setRefundEnabled(false);
      setRefundAmount("");
      onCreated();
    },
  });

  // Cada línea tildada necesita su elección explícita (fuera de débito, que
  // no la ofrece y ya va fija en `false`): el botón de emitir se bloquea
  // mientras falte alguna, para que nadie devuelva un plato por default.
  const checkedWithoutChoice = !isDebit && [...usedItemIds].some((id) => returnsToStock[id] === undefined);
  const canSubmit =
    lookupId !== null && kind !== "" && reason.trim() !== "" && usedItemIds.size > 0 && !checkedWithoutChoice;

  /**
   * **La lectura** (patrón 9): devuelve en palabras lo que el formulario está
   * por hacer. No suma ni deriva un peso — nombra las partes elegidas, que es
   * lo que el servidor va a recibir.
   */
  const lectura = (
    <>
      {lookupId === null ? (
        <>Cargá el documento original y la nota se arma sobre sus líneas. Nada se emite hasta «Emitir nota».</>
      ) : (
        <>
          Se emite <b className="font-bold text-foreground">{kind === "" ? "una nota" : KIND_LABEL[kind]}</b>{" "}
          sobre el documento cargado, con{" "}
          <b className="font-bold text-foreground tabular-nums">{usedItemIds.size}</b>{" "}
          {usedItemIds.size === 1 ? "línea marcada" : "líneas marcadas"}
          {refundEnabled ? (
            <>
              , y se devuelve plata al cliente por <b className="font-bold text-foreground">{refundMethod === "cash" ? "efectivo" : refundMethod === "card" ? "tarjeta" : refundMethod === "transfer" ? "transferencia" : "otro medio"}</b>
            </>
          ) : (
            <>, sin devolver plata</>
          )}
          . El original <b className="font-bold text-foreground">no se edita</b>: la nota lleva su propio
          consecutivo y deja al documento anterior como estaba.
        </>
      )}
    </>
  );

  return (
    <FormSection
      title="Nueva nota"
      columns="one"
      governs="Toda corrección de un documento ya emitido pasa por acá. El documento original queda reversado, nunca editado ni borrado."
      reading={lectura}
      doesNotDo={
        <>
          Emitir una nota <b className="font-bold text-foreground">no libera el consecutivo</b> del documento
          original ni lo saca del listado: el número sigue existiendo, porque el consecutivo no puede tener
          huecos.
        </>
      }
    >
      {confirmation ? (
        <p role="status" className="text-sm font-medium">
          {confirmation}
        </p>
      ) : null}

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
            setReturnsToStock({});
            setConfirmation(null);
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
                    <TableHead>Inventario</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => {
                    const included = usedItemIds.has(line.item_id);
                    const choice = returnsToStock[line.item_id];
                    const itemLabel = line.description ?? "ítem";
                    return (
                      <TableRow key={line.item_id}>
                        <TableCell>
                          <Checkbox
                            aria-label={`Incluir ${itemLabel} en la nota`}
                            checked={included}
                            onCheckedChange={(checked) => {
                              setUsedItemIds((prev) => {
                                const next = new Set(prev);
                                if (checked) next.add(line.item_id);
                                else next.delete(line.item_id);
                                return next;
                              });
                              if (!checked) {
                                // Se destilda: se borra la elección previa para
                                // que, si se vuelve a tildar, la pida de nuevo
                                // sin preseleccionar nada.
                                setReturnsToStock((prev) => {
                                  const next = { ...prev };
                                  delete next[line.item_id];
                                  return next;
                                });
                              }
                            }}
                          />
                        </TableCell>
                        <TableCell>{line.description ?? "—"}</TableCell>
                        <TableCell>{line.qty ?? 1}</TableCell>
                        <TableCell className="tabular-nums">{formatCOP(line.net)}</TableCell>
                        <TableCell>
                          {isDebit ? (
                            <span className="text-xs text-muted-foreground">No aplica (nota débito)</span>
                          ) : !included ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            <div className="space-y-1">
                              <div
                                role="radiogroup"
                                aria-label={`Devolución de inventario para ${itemLabel}`}
                                className="flex flex-wrap gap-2"
                              >
                                <button
                                  type="button"
                                  role="radio"
                                  aria-checked={choice === true}
                                  className={`h-9 rounded-md border px-2 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${
                                    choice === true ? "border-primary bg-primary/5" : "border-border"
                                  }`}
                                  onClick={() => setReturnsToStock((prev) => ({ ...prev, [line.item_id]: true }))}
                                >
                                  Vuelve al inventario
                                </button>
                                <button
                                  type="button"
                                  role="radio"
                                  aria-checked={choice === false}
                                  className={`h-9 rounded-md border px-2 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${
                                    choice === false ? "border-primary bg-primary/5" : "border-border"
                                  }`}
                                  onClick={() => setReturnsToStock((prev) => ({ ...prev, [line.item_id]: false }))}
                                >
                                  Se usó (no vuelve al inventario)
                                </button>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {choice === true
                                  ? "Los insumos de este plato vuelven al stock teórico."
                                  : choice === false
                                    ? "Los insumos no vuelven: el plato se consumió."
                                    : "Elegí una opción para poder emitir la nota."}
                              </p>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
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
    </FormSection>
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
  // De dónde vino el formulario prellenado. Se puede soltar sin cambiar la
  // URL —el parámetro sigue siendo el mismo y los enlaces guardados siguen
  // funcionando—, que es lo que pide la salida de la barra de procedencia.
  const [fromDocument, setFromDocument] = useState<number | null>(initialDocumentId);

  const query = useQuery({
    queryKey: ["fiscal-notes", activeStoreId, range],
    queryFn: () =>
      listNotes({ storeId: activeStoreId as number, from: range.from || undefined, to: range.to || undefined }),
    enabled: activeStoreId !== null,
  });

  if (storeLoading) {
    return <Cargando texto="Cargando sedes…" />;
  }
  if (activeStoreId === null) {
    return <p className="text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>;
  }

  const rows: AdminNoteListItem[] = query.data ?? [];
  const conRango = range.from !== "" || range.to !== "";

  // A la vista, cinco (mapa de pantallas, regla 3): la nota, qué corrige, por
  // qué, el total y cuándo. El tipo va detrás de «Más columnas»: el prefijo
  // del número ya lo dice, y la leyenda explica cuál corrige qué.
  const columns: readonly DenseColumn<AdminNoteListItem>[] = [
    { key: "number", header: "Nota", kind: "id", cell: (note) => note.full_number ?? `#${note.id}` },
    {
      key: "type",
      header: "Tipo",
      secondary: true,
      cell: (note) => (
        <Badge variant="outline">{note.document_type ? DOCUMENT_TYPE_LABEL[note.document_type] : "—"}</Badge>
      ),
    },
    {
      key: "reverses",
      header: "Corrige",
      kind: "secondary",
      cell: (note) => `Documento #${note.reverses_document_id} (reversado)`,
    },
    { key: "reason", header: "Motivo", cell: (note) => note.reason ?? "—" },
    { key: "total", header: "Total", kind: "number", cell: (note) => formatCOP(note.total) },
    {
      key: "date",
      header: "Emitida",
      kind: "secondary",
      widthPx: 100,
      cell: (note) => (note.issued_at ? <TimeAgo iso={note.issued_at} /> : (note.business_date ?? "—")),
      cellTitle: (note) => (note.issued_at ? formatInstant(note.issued_at) : undefined),
    },
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        name="Notas"
        question="¿Qué documentos hubo que corregir, por qué, y qué pasó con la plata y con el inventario de cada corrección?"
        context={[
          {
            label: "Sin flag: es ley",
            title: "El documento original se reversa, nunca se edita: la nota es el único camino.",
          },
          { label: "En el período", value: `${rows.length}` },
          {
            label: "Cada nota",
            value: "su propio consecutivo",
            title: "Ajuste, crédito y débito llevan su propio rango de numeración.",
          },
        ]}
        actions={
          <LocalCsvExportButton
            href={notesCsvUrl({ storeId: activeStoreId, from: range.from || undefined, to: range.to || undefined })}
          />
        }
      />

      {/* El reverso del «Emitir nota» de Documentos fiscales (patrón 6): el
          que sale nombra a dónde lleva, **el que llega lo reconoce** y ofrece
          la salida. Sin esto, quien aterriza acá con el documento ya cargado
          no tiene forma de saber por qué el formulario viene lleno. */}
      {fromDocument !== null ? (
        <OriginBar
          from={`Venís de Documentos fiscales › documento #${fromDocument}`}
          applied={[`documento #${fromDocument} ya cargado`]}
          exit={{ label: "Empezar una nota en blanco", onClick: () => setFromDocument(null) }}
          back={{ label: "Volver a Documentos", to: "/admin/fiscal/documentos" }}
        />
      ) : null}

      <NewNoteForm
        key={fromDocument ?? "blank"}
        initialDocumentId={fromDocument}
        onCreated={() => void queryClient.invalidateQueries({ queryKey: ["fiscal-notes", activeStoreId] })}
      />

      {query.isLoading ? (
        <Cargando texto="Cargando notas…" />
      ) : query.isError ? (
        <EmptyState
          role="alert"
          reason="error"
          title="No se pudieron cargar las notas"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (
        <DenseTable
          caption="Notas emitidas en el período"
          columns={columns}
          rows={rows}
          rowKey={(note) => String(note.id)}
          bar={
            <DenseTableBar shown={rows.length} total={rows.length} noun="notas en el período">
              <LocalDateRangeFilter from={range.from} to={range.to} onChange={setRange} />
            </DenseTableBar>
          }
          legend={[
            {
              term: "Reversado no es borrado",
              meaning:
                "el documento original sigue existiendo con su número; la nota es la que lo corrige. El consecutivo no admite huecos.",
            },
            {
              term: "Ajuste, crédito y débito",
              meaning:
                "el ajuste corrige un documento equivalente POS; crédito y débito corrigen una factura. El tipo lo decide el documento original, no quien emite.",
            },
            {
              term: "Devolver plata es aparte",
              meaning:
                "una nota puede no devolver nada. Si devuelve efectivo y no hay turno abierto, queda como devolución pendiente.",
            },
          ]}
          empty={
            conRango ? (
              <FilterEmptyState
                title="Todavía no hay notas en este período"
                filters={[`desde ${range.from || "—"} hasta ${range.to || "—"}`]}
                onRemove={() => setRange({ from: "", to: "" })}
              />
            ) : (
              <EmptyState
                title="Todavía no hay notas en este período"
                description="Cuando haya que corregir un documento, la nota va a aparecer acá."
              />
            )
          }
        />
      )}
    </div>
  );
}

export default NotesPage;
