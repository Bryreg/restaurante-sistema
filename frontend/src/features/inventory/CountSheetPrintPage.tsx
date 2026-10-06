import { useQuery } from "@tanstack/react-query"
import { Printer } from "lucide-react"
import { useSearchParams } from "react-router-dom"

import { getCountSheet } from "@/api/inventory"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"
import { formatFechaCorta } from "@/lib/format"

/**
 * **La hoja de conteo para imprimir** (`/imprimir/hoja-conteo?sede=ID`,
 * `&area=ID` para una sola área). Hoja A4 sin el marco del panel: una
 * sección por área, en el orden del estante, con columnas en blanco para
 * anotar lo contado. **A ciegas**: no lleva el stock del sistema; lo contado
 * se carga después en Inventario › Conteos.
 */
export function CountSheetPrintPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams()
  const storeId = Number(params.get("sede")) || null
  const areaId = Number(params.get("area")) || null

  const query = useQuery({
    queryKey: ["inventory", "count-sheet", storeId, areaId],
    queryFn: () => getCountSheet(storeId as number, areaId),
    enabled: storeId !== null,
  })

  if (storeId === null) {
    return <EmptyState reason="dependency" title="Falta de qué sede es la hoja" description="La dirección no nombra una sede." />
  }
  if (query.isLoading) return <Cargando texto="Armando la hoja…" className="p-6" />
  if (query.isError || !query.data) {
    return <EmptyState reason="error" title="No se pudo armar la hoja de conteo" description={errorMessage(query.error)} />
  }
  const sheet = query.data
  return (
    <div className="min-h-screen bg-neutral-100 py-6 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] flex-wrap items-end gap-3 px-4 print:hidden">
        {sheet.areas.length > 0 ? (
          <div className="space-y-1">
            <Label htmlFor="hoja-area">Área</Label>
            <Select
              value={areaId === null ? "all" : String(areaId)}
              onValueChange={(value) => {
                const next = new URLSearchParams(params)
                if (value === null || value === "all") next.delete("area")
                else next.set("area", value)
                setParams(next, { replace: true })
              }}
            >
              <SelectTrigger id="hoja-area" aria-label="Área" className="h-9 w-48 bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas las áreas</SelectItem>
                {sheet.areas.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <Button type="button" onClick={() => window.print()} className="gap-1.5">
          <Printer className="size-4" aria-hidden="true" />
          Imprimir hoja de conteo
        </Button>
        <span className="text-xs text-muted-foreground">Cada área sale en su propia hoja.</span>
      </div>

      {sheet.sections.length === 0 ? (
        <EmptyState reason="dependency" title="No hay insumos activos para contar" description="Cargá insumos en Inventario › Insumos." />
      ) : null}

      {sheet.sections.map((section, idx) => (
        <article
          key={`${section.area_id ?? "sin-area"}-${idx}`}
          aria-label={`Hoja de ${section.title}`}
          className="mx-auto mb-6 max-w-[210mm] break-after-page bg-white px-10 py-8 text-neutral-900 shadow-sm print:mb-0 print:max-w-none print:px-0 print:py-0 print:shadow-none"
        >
          <header className="flex items-end justify-between gap-6 border-b-2 border-neutral-900 pb-2">
            <div>
              <p className="text-[11px] tracking-[0.14em] text-neutral-500 uppercase">
                Hoja de conteo · {sheet.store_name}
              </p>
              <h1 className="mt-1 text-[24px] leading-tight font-bold">{section.title}</h1>
            </div>
            <div className="grid grid-cols-[auto_9rem] gap-x-2 gap-y-1 text-sm">
              <span>Fecha:</span>
              <span className="border-b border-neutral-500">&nbsp;</span>
              <span>Contó:</span>
              <span className="border-b border-neutral-500">&nbsp;</span>
              <span>Firma:</span>
              <span className="border-b border-neutral-500">&nbsp;</span>
            </div>
          </header>
          <table className="mt-3 w-full border-collapse text-[14px]">
            <thead className="text-left text-[11px] tracking-[0.08em] uppercase">
              <tr className="border-b border-neutral-500">
                <th className="w-8 py-1 pr-2 font-semibold">#</th>
                <th className="py-1 pr-2 font-semibold">Insumo</th>
                <th className="w-24 py-1 pr-2 font-semibold">Unidad</th>
                <th className="w-28 py-1 pr-2 font-semibold">Cantidad</th>
                <th className="w-48 py-1 font-semibold">Observaciones</th>
              </tr>
            </thead>
            <tbody>
              {section.items.map((item, i) => (
                <tr key={item.ingredient_id} className="h-8 border-b border-neutral-300">
                  <td className="pr-2 tabular-nums text-neutral-500">{i + 1}</td>
                  <td className="pr-2">{item.name}</td>
                  <td className="pr-2 text-neutral-600">{item.count_unit}</td>
                  <td className="border-l border-neutral-300" aria-label={`Cantidad de ${item.name}`} />
                  <td className="border-l border-neutral-300" />
                </tr>
              ))}
            </tbody>
          </table>
          <footer className="mt-4 text-[11px] text-neutral-500">
            Impresa para el día operativo {formatFechaCorta(sheet.business_date)}. A ciegas: contá lo que hay, no lo que
            debería haber. Lo contado se carga en Inventario › Conteos.
          </footer>
        </article>
      ))}
    </div>
  )
}

export default CountSheetPrintPage
