import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  getFiscal,
  getFiscalHistory,
  setFiscal,
  type FiscalConfigIn,
  type Regime,
  type PersonType,
  type TaxCode,
} from "@/api/stores";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBusinessDate } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";

function defaultValues(): FiscalConfigIn {
  return {
    valid_from: "",
    person_type: "natural",
    regime: "ordinary",
    franchise: false,
    inc_responsible: true,
    iva_responsible: false,
    rut_codes: [],
    price_includes_tax: true,
    default_tax: "inc_8",
  };
}

/** `GET/PUT /admin/stores/{id}/fiscal` — versionado por `valid_from`; nunca sobrescribe. */
export function FiscalSection({ storeId }: { storeId: number | null }): React.JSX.Element {
  const queryClient = useQueryClient();
  const currentQuery = useQuery({
    queryKey: ["admin-fiscal", storeId],
    queryFn: () => getFiscal(storeId as number),
    enabled: storeId !== null,
    retry: false,
  });
  const historyQuery = useQuery({
    queryKey: ["admin-fiscal-history", storeId],
    queryFn: () => getFiscalHistory(storeId as number),
    enabled: storeId !== null,
  });

  const [values, setValues] = useState<FiscalConfigIn>(defaultValues());
  const [rutCodesText, setRutCodesText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (storeId === null) {
    return <EmptyState title="Elegí una sede" description="Creá una sede en la pestaña Sedes primero." />;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await setFiscal(storeId, {
        ...values,
        rut_codes: rutCodesText
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-fiscal", storeId] }),
        queryClient.invalidateQueries({ queryKey: ["admin-fiscal-history", storeId] }),
      ]);
      setValues(defaultValues());
      setRutCodesText("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-3">
        <h2 className="text-sm font-medium">Vigente</h2>
        {currentQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : currentQuery.data ? (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">Desde</dt>
            <dd>{formatBusinessDate(currentQuery.data.valid_from)}</dd>
            <dt className="text-muted-foreground">Persona</dt>
            <dd>{currentQuery.data.person_type === "natural" ? "Natural" : "Jurídica"}</dd>
            <dt className="text-muted-foreground">Régimen</dt>
            <dd>{currentQuery.data.regime === "ordinary" ? "Ordinario" : "Simple"}</dd>
            <dt className="text-muted-foreground">Impuesto</dt>
            <dd>{currentQuery.data.default_tax}</dd>
            <dt className="text-muted-foreground">Precio incluye impuesto</dt>
            <dd>{currentQuery.data.price_includes_tax ? "Sí" : "No"}</dd>
          </dl>
        ) : (
          <EmptyState title="Sin configuración fiscal vigente" description="Cargá la primera abajo." />
        )}

        <h2 className="text-sm font-medium">Historial</h2>
        {historyQuery.data && historyQuery.data.length > 0 ? (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Desde</TableHead>
                  <TableHead>Régimen</TableHead>
                  <TableHead>Impuesto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {historyQuery.data.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{formatBusinessDate(row.valid_from)}</TableCell>
                    <TableCell>{row.regime}</TableCell>
                    <TableCell>{row.default_tax}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Sin versiones anteriores.</p>
        )}
      </div>

      <form className="space-y-3" onSubmit={handleSubmit}>
        <h2 className="text-sm font-medium">Cargar un cambio</h2>
        <div className="space-y-1.5">
          <Label htmlFor="fiscal-valid-from">Vigente desde</Label>
          <Input
            id="fiscal-valid-from"
            type="date"
            required
            className="h-11"
            value={values.valid_from}
            onChange={(e) => setValues((v) => ({ ...v, valid_from: e.target.value }))}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="fiscal-person-type">Persona</Label>
            <Select
              value={values.person_type}
              onValueChange={(v) => setValues((prev) => ({ ...prev, person_type: v as PersonType }))}
            >
              <SelectTrigger id="fiscal-person-type" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="natural">Natural</SelectItem>
                <SelectItem value="legal">Jurídica</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fiscal-regime">Régimen</Label>
            <Select
              value={values.regime}
              onValueChange={(v) => setValues((prev) => ({ ...prev, regime: v as Regime }))}
            >
              <SelectTrigger id="fiscal-regime" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ordinary">Ordinario</SelectItem>
                <SelectItem value="simple">Simple</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="fiscal-default-tax">Tasa por defecto</Label>
            <Select
              value={values.default_tax}
              onValueChange={(v) => setValues((prev) => ({ ...prev, default_tax: v as TaxCode }))}
            >
              <SelectTrigger id="fiscal-default-tax" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inc_8">INC 8%</SelectItem>
                <SelectItem value="iva_19">IVA 19%</SelectItem>
                <SelectItem value="excluded">Excluido</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fiscal-rut-codes">Códigos de responsabilidad RUT (separados por coma)</Label>
          <Input
            id="fiscal-rut-codes"
            className="h-11"
            value={rutCodesText}
            onChange={(e) => setRutCodesText(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={values.franchise}
              onCheckedChange={(c) => setValues((v) => ({ ...v, franchise: c === true }))}
            />
            Franquicia (IVA 19% en vez de INC 8%)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={values.inc_responsible}
              onCheckedChange={(c) => setValues((v) => ({ ...v, inc_responsible: c === true }))}
            />
            Responsable de INC
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={values.iva_responsible}
              onCheckedChange={(c) => setValues((v) => ({ ...v, iva_responsible: c === true }))}
            />
            Responsable de IVA
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={values.price_includes_tax}
              onCheckedChange={(c) => setValues((v) => ({ ...v, price_includes_tax: c === true }))}
            />
            Los precios de la carta incluyen el impuesto
          </label>
        </div>
        {error ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={saving}>
          {saving ? "Guardando…" : "Guardar nueva versión"}
        </Button>
      </form>
    </div>
  );
}
