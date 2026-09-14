import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import { listCombos, setComboOptionAvailability, setComboToday } from "@/api/catalog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"

export function DailyMenuTab({ storeId }: { storeId: number }) {
  const queryClient = useQueryClient()
  const [comboId, setComboId] = useState<number | null>(null)
  const [checkedOptionIds, setCheckedOptionIds] = useState<Set<number>>(new Set())

  const combosQuery = useQuery({
    queryKey: ["catalog", "combos", storeId],
    queryFn: () => listCombos(storeId),
  })
  const combos = combosQuery.data ?? []
  const combo = combos.find((c) => c.id === comboId) ?? null

  // Si todavía no se eligió ninguno, arranca en el primero: la mayoría de
  // las sedes tienen un solo menú del día y no tiene sentido pedir un clic
  // extra ("armar el menú de hoy en menos de dos minutos", SPEC-NEGOCIO §4.3).
  useEffect(() => {
    if (comboId === null && combos.length > 0) {
      setComboId(combos[0].id)
    }
  }, [comboId, combos])

  // Cuando cambia el combo elegido (o llegan datos nuevos del servidor tras
  // guardar), el checklist arranca marcado según `active_today` de cada
  // opción — nunca se inventa un estado inicial distinto del real.
  useEffect(() => {
    if (!combo) {
      setCheckedOptionIds(new Set())
      return
    }
    const active = new Set<number>()
    for (const group of combo.groups) {
      for (const option of group.options) {
        if (option.active_today) active.add(option.id)
      }
    }
    setCheckedOptionIds(active)
    // Sólo se recalcula cuando cambia el combo elegido o su identidad de
    // datos (no en cada render): sería sobreescribir lo que la persona
    // acaba de marcar antes de guardar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comboId, combo?.id])

  const saveMutation = useMutation({
    mutationFn: () => {
      if (comboId === null) throw new Error("Elegí un combo primero")
      return setComboToday(comboId, Array.from(checkedOptionIds))
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["catalog", "combos", storeId] })
    },
  })

  const availabilityMutation = useMutation({
    mutationFn: ({ optionId, available }: { optionId: number; available: boolean }) =>
      setComboOptionAvailability(optionId, available),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["catalog", "combos", storeId] }),
  })

  if (combosQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando combos…</p>
  }
  if (combosQuery.isError) {
    return <p className="text-sm text-destructive">{errorMessage(combosQuery.error)}</p>
  }

  return (
    <div className="space-y-4">
      <div className="max-w-sm space-y-1">
        <Label htmlFor="daily-menu-combo">Combo</Label>
        <Select
          value={comboId === null ? undefined : String(comboId)}
          onValueChange={(value) => setComboId(Number(value))}
        >
          <SelectTrigger id="daily-menu-combo" className="w-full">
            <SelectValue placeholder="Elegí un combo" />
          </SelectTrigger>
          <SelectContent>
            {combos.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {combos.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Todavía no hay combos. Creá uno en la pestaña Combos.
        </p>
      )}

      {combo && (
        <div className="space-y-4">
          {combo.groups.length === 0 && (
            <p className="text-sm text-muted-foreground">Este combo todavía no tiene grupos.</p>
          )}
          {combo.groups.map((group) => (
            <div key={group.id} className="space-y-2 rounded-md border p-3">
              <h3 className="font-medium">{group.name}</h3>
              <ul className="space-y-2">
                {group.options.map((option) => (
                  <li key={option.id} className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={checkedOptionIds.has(option.id)}
                        onCheckedChange={(checked) =>
                          setCheckedOptionIds((prev) => {
                            const next = new Set(prev)
                            if (checked) next.add(option.id)
                            else next.delete(option.id)
                            return next
                          })
                        }
                      />
                      {option.name}
                    </label>
                    <Button
                      type="button"
                      variant={option.available_today ? "outline" : "destructive"}
                      size="sm"
                      onClick={() =>
                        availabilityMutation.mutate({
                          optionId: option.id,
                          available: !option.available_today,
                        })
                      }
                    >
                      {option.available_today ? "Marcar agotado" : "Agotado — reactivar"}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <Button type="button" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            Guardar menú de hoy
          </Button>
          {saveMutation.isError && (
            <p className="text-sm text-destructive">{errorMessage(saveMutation.error)}</p>
          )}
        </div>
      )}
    </div>
  )
}
