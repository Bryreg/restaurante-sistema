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
import {
  ConsequenceZone,
  DenseTable,
  DenseTableBar,
  FormField,
  FormSection,
  type DenseColumn,
} from "@/components/admin";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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
/** La palabra del negocio, no el enum (patrón 8c): `inc_8` no le dice nada a nadie. */
const TAX_LABEL: Record<string, string> = { inc_8: "INC 8%", iva_19: "IVA 19%", excluded: "Excluido" };

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

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      await setFiscal(storeId as number, {
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

  const history = historyQuery.data ?? [];
  const historyColumns: readonly DenseColumn<(typeof history)[number]>[] = [
    { key: "from", header: "Vigente desde", kind: "name", cell: (row) => formatBusinessDate(row.valid_from) },
    { key: "regime", header: "Régimen", cell: (row) => (row.regime === "ordinary" ? "Ordinario" : "Simple") },
    { key: "tax", header: "Impuesto", cell: (row) => TAX_LABEL[row.default_tax] ?? row.default_tax },
  ];

  return (
    <div className="grid items-start gap-3 lg:grid-cols-2">
      <div className="space-y-3">
        <section className="rounded-lg border bg-card">
          <div className="flex items-center gap-2 border-b bg-muted px-3 py-2">
            <h2 className="text-xs tracking-wider text-muted-foreground uppercase">Vigente ahora</h2>
          </div>
          {currentQuery.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : currentQuery.data ? (
            <dl className="grid grid-cols-2 gap-2 px-3 py-3 text-sm">
              <dt className="text-muted-foreground">Desde</dt>
              <dd>{formatBusinessDate(currentQuery.data.valid_from)}</dd>
              <dt className="text-muted-foreground">Persona</dt>
              <dd>{currentQuery.data.person_type === "natural" ? "Natural" : "Jurídica"}</dd>
              <dt className="text-muted-foreground">Régimen</dt>
              <dd>{currentQuery.data.regime === "ordinary" ? "Ordinario" : "Simple"}</dd>
              <dt className="text-muted-foreground">Impuesto</dt>
              <dd>{TAX_LABEL[currentQuery.data.default_tax] ?? currentQuery.data.default_tax}</dd>
              <dt className="text-muted-foreground">Precio incluye impuesto</dt>
              <dd>{currentQuery.data.price_includes_tax ? "Sí" : "No"}</dd>
            </dl>
          ) : (
            <div className="p-3">
              <EmptyState
                title="Sin configuración fiscal vigente"
                description="Cargá la primera al lado: sin configuración fiscal, el cobro no sabe qué impuesto aplicar."
              />
            </div>
          )}
        </section>

        <DenseTable
          caption="Versiones anteriores de la configuración fiscal"
          columns={historyColumns}
          rows={history}
          rowKey={(row) => String(row.id)}
          bar={<DenseTableBar shown={history.length} total={history.length} noun="versiones" />}
          note={
            <>
              <b className="font-bold text-foreground">Versionada, nunca editada</b> — un cambio fiscal no
              corrige el pasado: crea una versión nueva con su fecha. Las ventas viejas conservan la que regía
              cuando se cobraron.
            </>
          }
          empty={<EmptyState title="Sin versiones anteriores" description="Ésta es la primera configuración de la sede." />}
        />
      </div>

      <div className="space-y-3">
        <FormSection
          title="Cargar un cambio"
          governs="La configuración fiscal no se edita: se carga una versión nueva con la fecha desde la que rige. Lo cobrado antes de esa fecha se queda como está."
          reading={
            <>
              Desde <b className="font-bold text-foreground">{values.valid_from || "la fecha que elijas"}</b>, el
              cobro va a aplicar{" "}
              <b className="font-bold text-foreground">{TAX_LABEL[values.default_tax] ?? values.default_tax}</b> por
              defecto, como persona{" "}
              <b className="font-bold text-foreground">{values.person_type === "natural" ? "natural" : "jurídica"}</b>{" "}
              en régimen{" "}
              <b className="font-bold text-foreground">{values.regime === "ordinary" ? "ordinario" : "simple"}</b>, y
              los precios de la carta{" "}
              <b className="font-bold text-foreground">
                {values.price_includes_tax ? "ya incluyen el impuesto" : "no incluyen el impuesto"}
              </b>
              .
            </>
          }
          doesNotDo="Cargar una versión nueva no recalcula ni corrige ningún documento ya emitido: lo que se congeló en la venta se queda ahí. Para corregir un documento existe la nota."
        >
          <FormField
            label="Vigente desde"
            help="Desde esta fecha rige la versión nueva. Antes de ella sigue rigiendo la anterior, y eso es lo que hace que un reporte viejo no cambie."
            className="sm:col-span-2"
          >
            {({ fieldId, describedBy }) => (
              <Input
                id={fieldId}
                aria-describedby={describedBy}
                type="date"
                required
                className="h-11"
                value={values.valid_from}
                onChange={(e) => setValues((v) => ({ ...v, valid_from: e.target.value }))}
              />
            )}
          </FormField>

          <FormField label="Persona" help="Natural o jurídica, como esté inscrita la sede en el RUT.">
            {({ fieldId, describedBy }) => (
              <Select
                value={values.person_type}
                onValueChange={(v) => setValues((prev) => ({ ...prev, person_type: v as PersonType }))}
              >
                <SelectTrigger id={fieldId} aria-describedby={describedBy} className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="natural">Natural</SelectItem>
                  <SelectItem value="legal">Jurídica</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>

          <FormField label="Régimen" help="Ordinario o SIMPLE. Cambia cómo se declara, no lo que el cliente paga en la mesa.">
            {({ fieldId, describedBy }) => (
              <Select
                value={values.regime}
                onValueChange={(v) => setValues((prev) => ({ ...prev, regime: v as Regime }))}
              >
                <SelectTrigger id={fieldId} aria-describedby={describedBy} className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ordinary">Ordinario</SelectItem>
                  <SelectItem value="simple">Simple</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>

          <FormField
            label="Tasa por defecto"
            help="El impuesto que lleva un plato nuevo si su ficha no dice otra cosa. Un restaurante no franquicia cobra INC 8 %; una franquicia, IVA 19 %."
            className="sm:col-span-2"
            scope={{ affects: [{ screen: "Salón › Cobro", verb: "Cambia" }] }}
          >
            {({ fieldId, describedBy }) => (
              <Select
                value={values.default_tax}
                onValueChange={(v) => setValues((prev) => ({ ...prev, default_tax: v as TaxCode }))}
              >
                <SelectTrigger id={fieldId} aria-describedby={describedBy} className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inc_8">INC 8%</SelectItem>
                  <SelectItem value="iva_19">IVA 19%</SelectItem>
                  <SelectItem value="excluded">Excluido</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>

          <FormField
            label="Códigos de responsabilidad RUT (separados por coma)"
            help="Los que van impresos en el documento electrónico. Los toma el proveedor tecnológico tal cual se escriban acá."
            className="sm:col-span-2"
            scope={{ affects: [{ screen: "Documentos fiscales", verb: "Imprime en" }] }}
          >
            {({ fieldId, describedBy }) => (
              <Input
                id={fieldId}
                aria-describedby={describedBy}
                className="h-11"
                value={rutCodesText}
                onChange={(e) => setRutCodesText(e.target.value)}
              />
            )}
          </FormField>

          <div className="space-y-2 sm:col-span-2">
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
        </FormSection>

        {error ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        ) : null}

        {/* Patrón 11 · zona ÁMBAR: reversible —se carga otra versión— pero
            cambia lo que el salón cobra desde la fecha elegida. El botón es
            azul y secundario, y la confirmación enumera dónde se va a notar. */}
        <ConsequenceZone
          level="reversible"
          scope="Todo lo que se cobre desde la fecha elegida"
          explanation="Una versión fiscal nueva no toca nada de lo ya cobrado, pero desde su fecha cambia el impuesto que el salón le cobra al cliente y lo que sale impreso en cada documento."
          action={{
            label: saving ? "Guardando…" : "Guardar nueva versión",
            confirmTitle: "Guardar nueva versión fiscal",
            disabled: saving || values.valid_from === "",
            consequences: [
              `Desde ${values.valid_from || "la fecha elegida"}, el cobro aplica ${TAX_LABEL[values.default_tax] ?? values.default_tax} por defecto.`,
              "Los documentos ya emitidos no cambian: conservan la versión que regía cuando se cobraron.",
              "La versión anterior queda en el historial, con su fecha, y se puede volver a cargar como una versión nueva.",
              "Queda registrado en Historial con quién la cargó.",
            ],
            onClick: () => void handleSubmit(),
          }}
        />
      </div>
    </div>
  );
}
