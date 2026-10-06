import { useQuery } from "@tanstack/react-query"
import { Printer } from "lucide-react"
import { useState } from "react"
import { useSearchParams } from "react-router-dom"

import { getPrintableSheet, type PrintableComponentOut, type SheetOwner } from "@/api/recipes"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOPDecimal } from "@/lib/money"

import { ALLERGEN_LABEL, STATION_LABEL } from "./fichaChef"

const UNIT: Record<string, string> = { g: "g", ml: "ml", unit: "und", kg: "kg", l: "l" }

function Componentes({ items, nivel = 0 }: { items: PrintableComponentOut[]; nivel?: number }): React.JSX.Element {
  return (
    <ul className={nivel === 0 ? "divide-y divide-neutral-300" : "mt-1 ml-5 border-l border-neutral-300 pl-3"}>
      {items.map((c, i) => (
        <li key={`${c.name}-${i}`} className={nivel === 0 ? "py-1.5" : "py-0.5 text-[13px]"}>
          <div className="flex items-baseline justify-between gap-4">
            <span>
              {c.name}
              {c.kind === "preparation" ? <span className="ml-1.5 text-[11px] uppercase tracking-wide text-neutral-500">preparación</span> : null}
            </span>
            <b className="tabular-nums whitespace-nowrap">
              {c.qty} {UNIT[c.unit] ?? c.unit}
            </b>
          </div>
          {c.components.length > 0 ? <Componentes items={c.components} nivel={nivel + 1} /> : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * **La ficha para imprimir** (`/imprimir/ficha?producto=ID` o
 * `?preparacion=ID`, `&costos=1` para la del dueño). Hoja A4 sin el marco del
 * panel: «Descargar PDF» abre el diálogo de impresión del navegador, que la
 * guarda como PDF o la manda a la impresora de la cocina. Las cantidades
 * vienen escaladas del servidor; acá no se multiplica nada.
 */
export function FichaImprimiblePage(): React.JSX.Element {
  const [params] = useSearchParams()
  const productId = Number(params.get("producto")) || null
  const prepId = Number(params.get("preparacion")) || null
  const costos = params.get("costos") === "1"
  const owner: SheetOwner | null = productId
    ? { kind: "product", id: productId }
    : prepId
      ? { kind: "preparation", id: prepId }
      : null
  const [scale, setScale] = useState(1)

  const query = useQuery({
    queryKey: ["recipes", "sheet-print", owner?.kind, owner?.id, scale, costos],
    queryFn: () => getPrintableSheet(owner as SheetOwner, scale, costos),
    enabled: owner !== null,
  })

  if (!owner) return <EmptyState reason="dependency" title="Falta qué ficha imprimir" description="La dirección no nombra un plato ni una preparación." />
  if (query.isLoading) return <Cargando texto="Armando la ficha…" className="p-6" />
  if (query.isError || !query.data) {
    return <EmptyState reason="error" title="No se pudo armar la ficha" description={errorMessage(query.error)} />
  }
  const f = query.data
  const s = f.sheet
  return (
    <div className="min-h-screen bg-neutral-100 py-6 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] flex-wrap items-end gap-3 px-4 print:hidden">
        <div className="space-y-1">
          <Label htmlFor="ficha-escala">{f.kind === "product" ? "Porciones" : "Tandas"}</Label>
          <Input
            id="ficha-escala"
            type="number"
            min={1}
            max={500}
            className="h-9 w-24 bg-white"
            value={scale}
            onChange={(e) => setScale(Math.min(500, Math.max(1, Math.round(Number(e.target.value) || 1))))}
          />
        </div>
        <Button type="button" onClick={() => window.print()} className="gap-1.5">
          <Printer className="size-4" aria-hidden="true" />
          Descargar PDF / imprimir
        </Button>
        <span className="text-xs text-muted-foreground">
          En el diálogo, elegí «Guardar como PDF» o la impresora de la cocina.
        </span>
      </div>

      <article className="mx-auto max-w-[210mm] bg-white px-10 py-8 text-neutral-900 shadow-sm print:max-w-none print:px-0 print:py-0 print:shadow-none">
        <header className="flex items-start justify-between gap-6 border-b-2 border-neutral-900 pb-3">
          <div>
            <p className="text-[11px] tracking-[0.14em] text-neutral-500 uppercase">
              {f.kind === "product" ? "Ficha técnica del plato" : "Ficha técnica de la preparación"}
              {f.recipe_version ? ` · versión ${f.recipe_version}` : ""}
            </p>
            <h1 className="mt-1 text-[28px] leading-tight font-bold">{f.name}</h1>
            <p className="mt-1 text-sm">
              <b>{f.scale_text}</b>
              {s.portion ? ` · ${s.portion}` : ""}
              {s.station ? ` · ${STATION_LABEL[s.station] ?? s.station}` : ""}
              {s.prep_minutes !== null ? ` · ${s.prep_minutes} min` : ""}
            </p>
          </div>
          {s.photo_url ? <img src={s.photo_url} alt={`Foto de ${f.name}`} className="h-28 w-28 rounded object-cover" /> : null}
        </header>

        {s.allergens.length > 0 ? (
          <p className="mt-3 rounded border-2 border-neutral-900 px-3 py-1.5 text-sm">
            <b>Alérgenos:</b> {s.allergens.map((a) => ALLERGEN_LABEL[a] ?? a).join(" · ")}
          </p>
        ) : null}

        <section className="mt-5 break-inside-avoid">
          <h2 className="text-[13px] font-bold tracking-[0.12em] uppercase">Ingredientes y preparaciones</h2>
          {f.components.length ? <Componentes items={f.components} /> : <p className="text-sm text-neutral-500">Sin componentes en la receta.</p>}
        </section>

        {s.method_steps.length > 0 ? (
          <section className="mt-5">
            <h2 className="text-[13px] font-bold tracking-[0.12em] uppercase">Método</h2>
            <ol className="mt-1 list-decimal space-y-1.5 pl-5 text-[15px] leading-snug">
              {s.method_steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </section>
        ) : null}

        {s.plating_notes ? (
          <section className="mt-5 break-inside-avoid">
            <h2 className="text-[13px] font-bold tracking-[0.12em] uppercase">Montaje</h2>
            <p className="mt-1 text-[15px] whitespace-pre-line">{s.plating_notes}</p>
          </section>
        ) : null}
        {s.chef_notes ? (
          <section className="mt-5 break-inside-avoid">
            <h2 className="text-[13px] font-bold tracking-[0.12em] uppercase">Notas del chef</h2>
            <p className="mt-1 text-[15px] whitespace-pre-line">{s.chef_notes}</p>
          </section>
        ) : null}

        {f.cost ? (
          <section className="mt-5 break-inside-avoid rounded border border-neutral-400 px-3 py-2 text-sm">
            <h2 className="text-[13px] font-bold tracking-[0.12em] uppercase">Costo</h2>
            <p>
              Total: <b>{f.cost.total === null ? "sin costo" : formatCOPDecimal(f.cost.total)}</b>
              {" · "}
              {f.kind === "product" ? "por porción" : "por unidad"}:{" "}
              {f.cost.per_unit === null ? "sin costo" : formatCOPDecimal(f.cost.per_unit)}
              {f.cost.food_cost_pct !== null ? ` · food cost ${f.cost.food_cost_pct} %` : ""}
            </p>
          </section>
        ) : null}

        <footer className="mt-6 border-t border-neutral-300 pt-2 text-[11px] text-neutral-500">
          Impresa el {formatInstant(f.generated_at)}
          {s.updated_by_employee_name ? ` · ficha editada por ${s.updated_by_employee_name}` : ""}
          {f.cost ? " · copia con costos: no dejar en la cocina" : ""}
        </footer>
      </article>
    </div>
  )
}

export default FichaImprimiblePage
