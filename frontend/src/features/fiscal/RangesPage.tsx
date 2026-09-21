import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useStoreSelection } from "@/app/storeContext";
import {
  DOCUMENT_TYPE_LABEL,
  RANGE_BACKED_DOCUMENT_TYPES,
  createFiscalRange,
  fiscalRangesCsvUrl,
  listFiscalRanges,
  type FiscalDocumentType,
  type FiscalRangeIn,
  type FiscalRangeOut,
} from "@/api/fiscal";
import { newIdempotencyKey } from "@/api/client";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DenseTable,
  DenseTableBar,
  PageHeader,
  type DenseColumn,
  type RowStatus,
} from "@/components/admin";
import { errorMessage } from "@/lib/errors";
import { parseBusinessDate } from "@/lib/businessDate";

import { LocalCsvExportButton } from "./components";

const RANGE_ALERT_CONSUMED_PCT = 0.8;
const RANGE_ALERT_DAYS_LEFT = 30;

/**
 * Ambos umbrales son presentación pura (nunca plata): el mismo criterio
 * declarado en `backend/app/fiscal/service.py` (`RANGE_ALERT_CONSUMED_PCT`,
 * `RANGE_ALERT_DAYS_LEFT`) para que esta pantalla muestre la misma alerta
 * que el servidor ya dispara como notificación `fiscal_range_low` — esta
 * franja es sólo un resaltado visual, la fuente de verdad sigue siendo el
 * servidor.
 */
function consumedRatio(range: FiscalRangeOut): number | null {
  if (range.from_number == null || range.to_number == null || range.consumed == null) return null;
  const total = range.to_number - range.from_number + 1;
  if (total <= 0) return null;
  return range.consumed / total;
}

function daysUntil(isoDate: string | undefined): number | null {
  if (!isoDate) return null;
  try {
    const { y, m, d } = parseBusinessDate(isoDate);
    const target = Date.UTC(y, m - 1, d);
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((target - today) / 86_400_000);
  } catch {
    return null;
  }
}

function isNearlyExhausted(range: FiscalRangeOut): boolean {
  const ratio = consumedRatio(range);
  return ratio !== null && ratio >= RANGE_ALERT_CONSUMED_PCT;
}

function isNearingExpiry(range: FiscalRangeOut): boolean {
  const days = daysUntil(range.valid_until);
  return days !== null && days <= RANGE_ALERT_DAYS_LEFT;
}

interface NewRangeForm {
  document_type: FiscalDocumentType;
  prefix: string;
  from_number: string;
  to_number: string;
  resolution_number: string;
  resolution_date: string;
  valid_from: string;
  valid_until: string;
  technical_key: string;
}

const EMPTY_FORM: NewRangeForm = {
  document_type: "pos_equivalent",
  prefix: "",
  from_number: "",
  to_number: "",
  resolution_number: "",
  resolution_date: "",
  valid_from: "",
  valid_until: "",
  technical_key: "",
};

function NewRangeDialog({
  storeId,
  open,
  onOpenChange,
}: {
  storeId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<NewRangeForm>(EMPTY_FORM);

  const mutation = useMutation({
    mutationFn: () => {
      const body: FiscalRangeIn = {
        store_id: storeId,
        document_type: form.document_type,
        prefix: form.prefix.trim(),
        from_number: Number(form.from_number),
        to_number: Number(form.to_number),
        resolution_number: form.resolution_number.trim(),
        resolution_date: form.resolution_date,
        valid_from: form.valid_from,
        valid_until: form.valid_until,
        technical_key: form.technical_key.trim() === "" ? undefined : form.technical_key.trim(),
      };
      return createFiscalRange(body, newIdempotencyKey());
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["fiscal-ranges", storeId] });
      setForm(EMPTY_FORM);
      onOpenChange(false);
    },
  });

  const canSubmit =
    form.prefix.trim() !== "" &&
    form.from_number !== "" &&
    form.to_number !== "" &&
    form.resolution_number.trim() !== "" &&
    form.resolution_date !== "" &&
    form.valid_from !== "" &&
    form.valid_until !== "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nuevo rango de numeración</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="range-doc-type">Tipo de documento</Label>
            <Select
              value={form.document_type}
              onValueChange={(v) => setForm((f) => ({ ...f, document_type: v as FiscalDocumentType }))}
            >
              <SelectTrigger id="range-doc-type" className="h-11 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_BACKED_DOCUMENT_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {DOCUMENT_TYPE_LABEL[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="range-prefix">Prefijo</Label>
              <Input
                id="range-prefix"
                className="h-11"
                value={form.prefix}
                onChange={(e) => setForm((f) => ({ ...f, prefix: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="range-technical-key">Clave técnica (opcional)</Label>
              <Input
                id="range-technical-key"
                className="h-11"
                value={form.technical_key}
                onChange={(e) => setForm((f) => ({ ...f, technical_key: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="range-from">Desde (número)</Label>
              <Input
                id="range-from"
                type="number"
                min={1}
                className="h-11"
                value={form.from_number}
                onChange={(e) => setForm((f) => ({ ...f, from_number: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="range-to">Hasta (número)</Label>
              <Input
                id="range-to"
                type="number"
                min={1}
                className="h-11"
                value={form.to_number}
                onChange={(e) => setForm((f) => ({ ...f, to_number: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="range-resolution-number">Número de resolución</Label>
              <Input
                id="range-resolution-number"
                className="h-11"
                value={form.resolution_number}
                onChange={(e) => setForm((f) => ({ ...f, resolution_number: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="range-resolution-date">Fecha de resolución</Label>
              <Input
                id="range-resolution-date"
                type="date"
                className="h-11"
                value={form.resolution_date}
                onChange={(e) => setForm((f) => ({ ...f, resolution_date: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="range-valid-from">Vigente desde</Label>
              <Input
                id="range-valid-from"
                type="date"
                className="h-11"
                value={form.valid_from}
                onChange={(e) => setForm((f) => ({ ...f, valid_from: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="range-valid-until">Vigente hasta</Label>
              <Input
                id="range-valid-until"
                type="date"
                className="h-11"
                value={form.valid_until}
                onChange={(e) => setForm((f) => ({ ...f, valid_until: e.target.value }))}
              />
            </div>
          </div>

          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}

          <Button type="submit" className="h-11 w-full" disabled={!canSubmit || mutation.isPending}>
            {mutation.isPending ? "Creando…" : "Crear rango"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
/**
 * La franja de estado de la fila (patrón 8b). Un rango que se está acabando y
 * uno que se está venciendo son **dos problemas distintos** que terminan en
 * el mismo lugar: el día que no haya ninguno vigente, el cobro falla antes de
 * cobrar.
 */
function estadoDeRango(range: FiscalRangeOut): RowStatus {
  const dias = daysUntil(range.valid_until);
  if (dias !== null && dias < 0) return "critical";
  if (isNearlyExhausted(range) || isNearingExpiry(range)) return "warning";
  return "ok";
}

/**
 * Admin → Documentos fiscales → Rangos de numeración (SPEC-NEGOCIO §8.3,
 * `spec.md` "API contract → Admin fiscal"): `GET/POST /admin/fiscal/ranges`.
 * Avance del rango y alerta al 80 % consumido / 30 días para vencer
 * (presentación; la alerta real es la notificación del servidor,
 * `fiscal_range_low`, `src/features/notifications/**`, ajeno).
 */
export function RangesPage(): React.JSX.Element {
  const { activeStoreId, loading: storeLoading } = useStoreSelection();
  const [dialogOpen, setDialogOpen] = useState(false);

  const query = useQuery({
    queryKey: ["fiscal-ranges", activeStoreId],
    queryFn: () => listFiscalRanges(activeStoreId as number),
    enabled: activeStoreId !== null,
  });

  if (storeLoading) {
    return <p className="text-sm text-muted-foreground">Cargando sedes…</p>;
  }
  if (activeStoreId === null) {
    return <p className="text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>;
  }

  const rows = query.data ?? [];
  const porAvisar = rows.filter((range) => estadoDeRango(range) !== "ok").length;

  const columns: readonly DenseColumn<FiscalRangeOut>[] = [
    {
      key: "type",
      header: "Tipo",
      cell: (range) => (range.document_type ? DOCUMENT_TYPE_LABEL[range.document_type] : "—"),
    },
    { key: "prefix", header: "Prefijo", kind: "id", cell: (range) => range.prefix ?? "—" },
    {
      key: "range",
      header: "Rango",
      kind: "number",
      cell: (range) => `${range.from_number ?? "—"}–${range.to_number ?? "—"}`,
    },
    {
      key: "resolution",
      header: "Resolución",
      kind: "secondary",
      cell: (range) =>
        `${range.resolution_number ?? "—"}${range.resolution_date ? ` · ${range.resolution_date}` : ""}`,
    },
    {
      key: "validity",
      header: "Vigencia",
      kind: "secondary",
      cell: (range) => `${range.valid_from ?? "—"} a ${range.valid_until ?? "—"}`,
    },
    {
      key: "consumed",
      header: "Consumido",
      widthPx: 150,
      cell: (range) => {
        const ratio = consumedRatio(range);
        const total =
          range.from_number != null && range.to_number != null ? range.to_number - range.from_number + 1 : null;
        return (
          <span className="flex items-center gap-2">
            <span className="text-xs tabular-nums">
              {range.consumed ?? "—"} / {total ?? "—"}
              {ratio !== null ? ` (${Math.round(ratio * 100)} %)` : ""}
            </span>
            {ratio !== null ? (
              <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
                />
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "alerts",
      header: "Avisos",
      cell: (range) => (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          {isNearlyExhausted(range) ? <Badge variant="outline">80 % consumido</Badge> : null}
          {isNearingExpiry(range) ? <Badge variant="outline">Vence en 30 días o menos</Badge> : null}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <PageHeader
        name="Rangos de numeración"
        question="¿Con qué numeración autorizada está cobrando esta sede, y cuánto le queda antes de quedarse sin consecutivo?"
        context={[
          {
            label: "Sin flag: es ley",
            title: "El consecutivo sin huecos y su rango autorizado no se apagan desde Funciones.",
          },
          {
            label: "Avisan",
            value: `${porAvisar} de ${rows.length}`,
            title: "Rangos al 80 % o con 30 días o menos de vigencia.",
          },
          {
            label: "Sin rango vigente",
            value: "el cobro falla",
            title: "Un cobro que necesite documento equivalente o factura falla antes de cobrar.",
          },
        ]}
        actions={
          <>
            <LocalCsvExportButton href={fiscalRangesCsvUrl(activeStoreId)} />
            <Button type="button" onClick={() => setDialogOpen(true)}>
              Nuevo rango
            </Button>
          </>
        }
      />

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando rangos…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          reason="error"
          title="No se pudieron cargar los rangos"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : (
        <DenseTable
          caption="Rangos de numeración autorizados por la DIAN para esta sede"
          columns={columns}
          rows={rows}
          rowKey={(range) => String(range.id)}
          rowStatus={estadoDeRango}
          bar={
            <DenseTableBar
              shown={rows.length}
              total={rows.length}
              noun="rangos cargados"
              hidden={porAvisar > 0 ? `${porAvisar} con aviso` : "ninguno con aviso"}
            />
          }
          legend={[
            {
              term: "Consumido no es vencido",
              meaning:
                "un rango se acaba por números o por fecha, y son dos cosas distintas: el primero se agota vendiendo, el segundo llega solo.",
            },
            {
              term: "Los avisos son de antes",
              meaning:
                "al 80 % y a los 30 días hay tiempo de pedir una resolución nueva. El día que no quede ninguno vigente ya es tarde: el cobro falla antes de cobrar.",
            },
            {
              term: "Clave técnica",
              meaning: "sólo la piden algunos tipos de documento; vacía no es un error.",
            },
          ]}
          empty={
            <EmptyState
              title="Todavía no hay rangos cargados"
              description="Sin un rango vigente, un cobro que necesite documento equivalente o factura falla con 400 antes de cobrar."
              action={{ label: "Nuevo rango", onClick: () => setDialogOpen(true) }}
            />
          }
        />
      )}

      <NewRangeDialog storeId={activeStoreId} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

export default RangesPage;
