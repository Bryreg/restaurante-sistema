/**
 * Los costos fijos de la sede — la PUERTA DE ENTRADA del punto de equilibrio.
 *
 * Existe por el hallazgo A-1 del cierre de la fase 3: `GET`/`PATCH
 * /admin/expenses/settings` estaban construidos y probados, pero **ninguna
 * pantalla los consumía**, así que `GET /admin/break-even` respondía
 * `available: false` para siempre y el motivo que devolvía le nombraba al
 * dueño una ruta de API que no puede abrir. La matemática estaba bien en las
 * dos puntas; lo que faltaba era por dónde entra el dato.
 *
 * Va DENTRO de la pestaña del punto de equilibrio, no en una pantalla de
 * configuración aparte, y a propósito: el lugar donde alguien se entera de que
 * le faltan los costos fijos es exactamente donde tiene que poder cargarlos.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import { getExpensesSettings, updateExpensesSettings } from "@/api/expenses"
import { MoneyInput } from "@/components/MoneyInput"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { errorMessage } from "@/lib/errors"

export function FixedCostsCard({ storeId }: { storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<number | null>(null)
  const [touched, setTouched] = useState(false)

  const query = useQuery({
    queryKey: ["expenses", "settings", storeId],
    queryFn: () => getExpensesSettings(storeId),
  })

  // El valor guardado sólo se copia al borrador mientras la persona no haya
  // tocado el campo: un refetch en segundo plano no le pisa lo que está
  // escribiendo (es la misma regla que el conteo de inventario: "un borrador
  // local nunca pisa un valor confirmado", y tampoco al revés).
  useEffect(() => {
    if (!touched && query.data) setDraft(query.data.fixed_costs)
  }, [query.data, touched])

  const mutation = useMutation({
    mutationFn: () => updateExpensesSettings(storeId, { fixed_costs: draft }),
    onSuccess: (saved) => {
      setTouched(false)
      setDraft(saved.fixed_costs)
      // El punto de equilibrio y la utilidad dependen de esto: se reconsultan
      // los dos, no sólo el que está a la vista.
      void queryClient.invalidateQueries({ queryKey: ["expenses", "settings", storeId] })
      void queryClient.invalidateQueries({ queryKey: ["expenses", "break-even", storeId] })
      void queryClient.invalidateQueries({ queryKey: ["expenses", "profit", storeId] })
    },
  })

  return (
    <div className="rounded-lg border p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <Label htmlFor="fixed-costs">Costos fijos del período</Label>
          <MoneyInput
            id="fixed-costs"
            value={draft}
            onChange={(v) => {
              setTouched(true)
              setDraft(v)
            }}
            disabled={query.isLoading || mutation.isPending}
          />
          <p className="text-xs text-muted-foreground">
            Arriendo, servicios y todo lo que se paga esté abierto o cerrado. Sin este dato el punto de equilibrio no
            se puede calcular, y el sistema lo dice con el motivo en vez de mostrar una cifra en cero.
          </p>
        </div>
        <Button type="button" onClick={() => mutation.mutate()} disabled={!touched || mutation.isPending}>
          {mutation.isPending ? "Guardando…" : "Guardar costos fijos"}
        </Button>
      </div>

      {query.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          No se pudieron leer los costos fijos: {errorMessage(query.error)}
        </p>
      ) : null}
      {mutation.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
      {!query.isLoading && !query.isError && query.data?.fixed_costs === null && !touched ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Todavía no hay costos fijos cargados para esta sede.
        </p>
      ) : null}
    </div>
  )
}

export default FixedCostsCard
