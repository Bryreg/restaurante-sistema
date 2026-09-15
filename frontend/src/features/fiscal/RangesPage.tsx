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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Rangos de numeración</h1>
          <p className="text-sm text-muted-foreground">
            Autorizados por la DIAN, por tipo de documento. El consecutivo se reserva dentro del rango vigente; un
            cobro sin rango vigente falla antes de cobrar.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <LocalCsvExportButton href={fiscalRangesCsvUrl(activeStoreId)} />
          <Button type="button" className="h-11" onClick={() => setDialogOpen(true)}>
            Nuevo rango
          </Button>
        </div>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando rangos…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudieron cargar los rangos" description={errorMessage(query.error)} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Todavía no hay rangos cargados"
          description="Sin un rango vigente, un cobro que necesite documento equivalente o factura falla con 400 antes de cobrar."
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead>Prefijo</TableHead>
                <TableHead>Rango</TableHead>
                <TableHead>Resolución</TableHead>
                <TableHead>Vigencia</TableHead>
                <TableHead>Consumido</TableHead>
                <TableHead>Avisos</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((range) => {
                const ratio = consumedRatio(range);
                const total = range.from_number != null && range.to_number != null ? range.to_number - range.from_number + 1 : null;
                return (
                  <TableRow key={range.id}>
                    <TableCell>{range.document_type ? DOCUMENT_TYPE_LABEL[range.document_type] : "—"}</TableCell>
                    <TableCell>{range.prefix ?? "—"}</TableCell>
                    <TableCell>
                      {range.from_number ?? "—"}–{range.to_number ?? "—"}
                    </TableCell>
                    <TableCell>
                      {range.resolution_number ?? "—"}
                      {range.resolution_date ? ` · ${range.resolution_date}` : ""}
                    </TableCell>
                    <TableCell>
                      {range.valid_from ?? "—"} a {range.valid_until ?? "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <span className="tabular-nums text-xs">
                          {range.consumed ?? "—"} / {total ?? "—"}
                          {ratio !== null ? ` (${Math.round(ratio * 100)} %)` : ""}
                        </span>
                        {ratio !== null ? (
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                            <div
                              className="h-full rounded-full bg-primary"
                              style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
                            />
                          </div>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {isNearlyExhausted(range) ? <Badge variant="outline">80 % consumido</Badge> : null}
                        {isNearingExpiry(range) ? <Badge variant="outline">Vence en 30 días o menos</Badge> : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <NewRangeDialog storeId={activeStoreId} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

export default RangesPage;
