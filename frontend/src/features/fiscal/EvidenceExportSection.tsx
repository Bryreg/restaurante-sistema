/**
 * Admin → Documentos fiscales → Exportar paquete de evidencia (c7,
 * `GET /admin/fiscal/export`): elegir un período, ver qué lleva el paquete
 * (`getFiscalExportBundle`: cuántos documentos y el hash del manifiesto,
 * tal como los calcula el servidor) y descargarlo para guardarlo fuera del
 * sistema. La conservación de 5 años se dice en pantalla, no sólo en un
 * tooltip.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { csvUrl } from "@/api/client";
import { fiscalExportUrl, getFiscalExportBundle } from "@/api/fiscal";
import { Cargando } from "@/components/Cargando";
import { Button } from "@/components/ui/button";
import { formatBusinessDate, formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";

import { LocalCsvExportButton, LocalDateRangeFilter } from "./components";
import { previousMonth, previousYear, todayBogota } from "./periods";

export function EvidenceExportSection({ storeId }: { storeId: number }): React.JSX.Element {
  const [range, setRange] = useState({ from: "", to: "" });
  const [preview, setPreview] = useState<{ from: string; to: string } | null>(null);

  const complete = range.from !== "" && range.to !== "";
  const ordered = complete && range.from <= range.to;
  const previewing = preview !== null && preview.from === range.from && preview.to === range.to;

  const bundle = useQuery({
    queryKey: ["fiscal-export-bundle", storeId, preview?.from, preview?.to],
    queryFn: () => getFiscalExportBundle({ storeId, from: (preview as { from: string }).from, to: (preview as { to: string }).to }),
    enabled: previewing,
  });

  return (
    <section aria-labelledby="fiscal-export-title" className="space-y-3 rounded-lg border bg-card p-3">
      <h2 id="fiscal-export-title" className="text-sm font-bold">
        Exportar paquete de evidencia
      </h2>
      <p data-testid="fiscal-export-retention" className="rounded-md border border-l-4 border-l-primary bg-primary/5 p-2 text-sm">
        <b>Guardalo 5 años.</b> La ley tributaria pide conservar los documentos equivalentes y su soporte durante
        cinco años (Estatuto Tributario, art. 632; Res. DIAN 000165 de 2023). Descargá un paquete por período —por
        ejemplo, cada mes— y guardalo fuera del sistema.
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer rounded-md py-0.5 font-medium select-none hover:text-foreground">
          ¿Qué lleva el paquete?
        </summary>
        <p className="pt-1 leading-relaxed">
          Un manifiesto con cada documento del período (número, tipo, fecha, total y su hash) y el hash del
          manifiesto entero: si alguien cambia un documento después, el hash ya no coincide.
        </p>
      </details>

      <div className="flex flex-wrap items-end gap-2">
        <LocalDateRangeFilter from={range.from} to={range.to} onChange={setRange} />
        <Button type="button" variant="outline" className="h-10" onClick={() => setRange(previousMonth(todayBogota()))}>
          Mes anterior
        </Button>
        <Button type="button" variant="outline" className="h-10" onClick={() => setRange(previousYear(todayBogota()))}>
          Año anterior
        </Button>
      </div>

      {!complete ? (
        <p className="text-xs text-muted-foreground">
          Elegí las dos fechas: un paquete sin período no es evidencia de nada.
        </p>
      ) : !ordered ? (
        <p role="alert" className="text-xs text-destructive">
          La fecha «Desde» tiene que ser anterior o igual a «Hasta».
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={() => setPreview({ ...range })}>
              Ver qué lleva
            </Button>
            <LocalCsvExportButton
              href={fiscalExportUrl({ storeId, from: range.from, to: range.to })}
              label="Descargar paquete (.json)"
            />
            <LocalCsvExportButton
              href={csvUrl("/admin/fiscal/export", { store_id: storeId, from: range.from, to: range.to })}
              label="Descargar lista (.csv)"
            />
          </div>
          {previewing ? (
            bundle.isLoading ? (
              <Cargando texto="Armando el paquete…" />
            ) : bundle.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(bundle.error)}
              </p>
            ) : bundle.data ? (
              <dl data-testid="fiscal-export-preview" className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                <dt className="text-muted-foreground">Período</dt>
                <dd>
                  {formatBusinessDate(bundle.data.date_from ?? range.from)} a{" "}
                  {formatBusinessDate(bundle.data.date_to ?? range.to)}
                </dd>
                <dt className="text-muted-foreground">Documentos</dt>
                <dd className="tabular-nums">{bundle.data.document_count ?? "—"}</dd>
                <dt className="text-muted-foreground">Hash del manifiesto</dt>
                <dd className="font-mono text-xs break-all">{bundle.data.manifest_hash ?? "—"}</dd>
                <dt className="text-muted-foreground">Generado</dt>
                <dd>{formatInstant(bundle.data.generated_at)}</dd>
              </dl>
            ) : null
          ) : null}
          {previewing && bundle.data?.document_count === 0 ? (
            <p className="text-xs text-muted-foreground">
              No hubo documentos en ese período: el paquete sale vacío, y también sirve como constancia.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default EvidenceExportSection;
