import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import type { ComboGroupIn, ComboSchedule } from "@/api/catalog"
import { createCombo, listCombos, listProducts, updateCombo } from "@/api/catalog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { errorMessage } from "@/lib/errors"
import { formatCOP, parseCOP } from "@/lib/money"

const WEEKDAY_LABELS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]

function defaultSchedule(): ComboSchedule {
  return { days: [0, 1, 2, 3, 4, 5, 6], from: "11:00", to: "22:00" }
}

function ScheduleEditor({
  schedule,
  onChange,
}: {
  schedule: ComboSchedule
  onChange: (schedule: ComboSchedule) => void
}) {
  return (
    <div className="space-y-2">
      <Label>Días</Label>
      <div className="flex gap-2">
        {WEEKDAY_LABELS.map((label, day) => (
          <label key={day} className="flex flex-col items-center gap-1 text-xs">
            <Checkbox
              checked={schedule.days.includes(day)}
              onCheckedChange={(checked) =>
                onChange({
                  ...schedule,
                  days: checked
                    ? [...schedule.days, day].sort()
                    : schedule.days.filter((d) => d !== day),
                })
              }
              aria-label={label}
            />
            {label}
          </label>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="schedule-from">Desde</Label>
          <Input
            id="schedule-from"
            type="time"
            value={schedule.from}
            onChange={(event) => onChange({ ...schedule, from: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="schedule-to">Hasta</Label>
          <Input
            id="schedule-to"
            type="time"
            value={schedule.to}
            onChange={(event) => onChange({ ...schedule, to: event.target.value })}
          />
        </div>
      </div>
    </div>
  )
}

function CreateComboDialog({ storeId }: { storeId: number }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [price, setPrice] = useState<number | null>(null)
  const [schedule, setSchedule] = useState<ComboSchedule>(defaultSchedule())
  const [groupProductIds, setGroupProductIds] = useState<number[]>([])

  const productsQuery = useQuery({
    queryKey: ["catalog", "products", storeId],
    queryFn: () => listProducts(storeId),
    enabled: open,
  })

  const createMutation = useMutation({
    mutationFn: () => {
      const groups: ComboGroupIn[] =
        groupProductIds.length > 0
          ? [{ name: "Opciones", options: groupProductIds.map((id) => ({ product_id: id })) }]
          : []
      return createCombo(storeId, { name, price: price ?? 0, active: groups.length > 0, schedule, groups })
    },
    onSuccess: () => {
      setOpen(false)
      setName("")
      setPrice(null)
      setGroupProductIds([])
      void queryClient.invalidateQueries({ queryKey: ["catalog", "combos", storeId] })
    },
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>Nuevo combo</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo combo</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            createMutation.mutate()
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="combo-name">Nombre</Label>
            <Input id="combo-name" required value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="combo-price">Precio</Label>
            <Input
              id="combo-price"
              inputMode="numeric"
              required
              value={price === null ? "" : formatCOP(price)}
              onChange={(event) => setPrice(parseCOP(event.target.value))}
            />
          </div>
          <ScheduleEditor schedule={schedule} onChange={setSchedule} />
          <div className="space-y-2">
            <Label>Opciones (al menos una para poder activarlo)</Label>
            {productsQuery.isLoading && <p className="text-sm text-muted-foreground">Cargando productos…</p>}
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
              {(productsQuery.data ?? []).map((product) => (
                <label key={product.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={groupProductIds.includes(product.id)}
                    onCheckedChange={(checked) =>
                      setGroupProductIds((prev) =>
                        checked ? [...prev, product.id] : prev.filter((id) => id !== product.id)
                      )
                    }
                  />
                  {product.name}
                </label>
              ))}
            </div>
          </div>
          {createMutation.isError && (
            <p className="text-sm text-destructive">{errorMessage(createMutation.error)}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={createMutation.isPending || name.trim() === "" || price === null}>
              Crear
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function CombosTab({ storeId }: { storeId: number }) {
  const queryClient = useQueryClient()
  const combosQuery = useQuery({
    queryKey: ["catalog", "combos", storeId],
    queryFn: () => listCombos(storeId),
  })

  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) => updateCombo(id, { active }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["catalog", "combos", storeId] }),
  })

  if (combosQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando combos…</p>
  }
  if (combosQuery.isError) {
    return <p className="text-sm text-destructive">{errorMessage(combosQuery.error)}</p>
  }

  const combos = combosQuery.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <CreateComboDialog storeId={storeId} />
      </div>

      {toggleActive.isError && (
        <p className="text-sm text-destructive">{errorMessage(toggleActive.error)}</p>
      )}

      {combos.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no hay combos.</p>
      ) : (
        <ul className="space-y-2">
          {combos.map((combo) => (
            <li key={combo.id} className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="font-medium">{combo.name}</p>
                <p className="text-sm text-muted-foreground">
                  {formatCOP(combo.price)} · {combo.groups.length} grupo(s)
                </p>
              </div>
              <div className="flex items-center gap-2">
                {combo.active_now && <Badge variant="secondary">En franja ahora</Badge>}
                <Label htmlFor={`combo-active-${combo.id}`} className="text-sm">
                  Activo
                </Label>
                <Checkbox
                  id={`combo-active-${combo.id}`}
                  checked={combo.active}
                  onCheckedChange={(checked) =>
                    toggleActive.mutate({ id: combo.id, active: checked === true })
                  }
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
