import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { toast } from "sonner"

import { createAreaRecount, listCountAreas } from "@/api/areaCounts"
import { ApiError, newIdempotencyKey } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/lib/errors"

import { AREA_COUNTS_QUERY_KEYS } from "./areaCountLib"

const MAX = 5

/**
 * «Pedir recuento»: el administrador elige un área y 1–5 de sus artículos; el
 * pedido le aparece como pendiente en el POS de esa área, y quien lo cuenta
 * no ve el stock del sistema. La respuesta vuelve a Hoy con su diferencia
 * contra el sistema en ese instante. Se usa en Inventario › Conteo por área
 * y en la tarjeta de Hoy.
 */
export function RecountDialog({
  storeId,
  triggerVariant = "default",
  onCreated,
}: {
  storeId: number
  triggerVariant?: "default" | "outline"
  onCreated?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [areaId, setAreaId] = useState<number | null>(null)
  const [chosen, setChosen] = useState<number[]>([])
  const [note, setNote] = useState("")
  const keyRef = useRef(newIdempotencyKey())
  const queryClient = useQueryClient()

  const areasQuery = useQuery({
    queryKey: AREA_COUNTS_QUERY_KEYS.areas(storeId),
    queryFn: () => listCountAreas(storeId),
    enabled: open,
  })
  const areas = (areasQuery.data ?? []).filter((a) => a.active && a.items.length > 0)
  const area = areas.find((a) => a.id === areaId) ?? null

  const mutation = useMutation({
    mutationFn: () =>
      createAreaRecount(
        storeId,
        { area_id: areaId as number, ingredient_ids: chosen, note: note.trim() === "" ? null : note.trim() },
        keyRef.current,
      ),
    onSuccess: (r) => {
      toast.success(`Recuento pedido a ${r.area_name}.`)
      keyRef.current = newIdempotencyKey()
      setOpen(false)
      setAreaId(null)
      setChosen([])
      setNote("")
      void queryClient.invalidateQueries({ queryKey: ["area-counts"] })
      void queryClient.invalidateQueries({ queryKey: ["admin-today"] })
      onCreated?.()
    },
    onError: (err) => {
      if (!(err instanceof ApiError) || err.status !== 409) keyRef.current = newIdempotencyKey()
    },
  })

  function toggle(id: number, on: boolean) {
    setChosen((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) mutation.reset()
      }}
    >
      <DialogTrigger render={<Button variant={triggerVariant} size="sm" />}>Pedir recuento</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Pedir un recuento sorpresa</DialogTitle>
          <DialogDescription>
            Le aparece como pendiente en el POS del área. Quien cuenta no ve el stock del sistema; la respuesta
            vuelve a Hoy con su diferencia.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="recount-area">Área</Label>
            <Select
              value={areaId === null ? undefined : String(areaId)}
              onValueChange={(v) => {
                setAreaId(Number(v))
                setChosen([])
              }}
            >
              <SelectTrigger id="recount-area" className="w-full">
                <SelectValue placeholder="Elegí un área" />
              </SelectTrigger>
              <SelectContent>
                {areas.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {areasQuery.isSuccess && areas.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No hay áreas con artículos. Armalas en Inventario › Conteo por área.
              </p>
            ) : null}
          </div>
          {area ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                Artículos a recontar ({chosen.length} de {MAX} como máximo)
              </legend>
              <ul className="space-y-1.5">
                {area.items.map((item) => {
                  const checked = chosen.includes(item.ingredient_id)
                  const id = `recount-item-${item.ingredient_id}`
                  return (
                    <li key={item.ingredient_id} className="flex items-center gap-2">
                      <Checkbox
                        id={id}
                        checked={checked}
                        disabled={!checked && chosen.length >= MAX}
                        onCheckedChange={(v) => toggle(item.ingredient_id, v === true)}
                      />
                      <Label htmlFor={id} className="font-normal">
                        {item.name}
                      </Label>
                    </li>
                  )
                })}
              </ul>
            </fieldset>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="recount-note">Nota para quien cuenta (opcional)</Label>
            <Textarea id="recount-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            disabled={areaId === null || chosen.length === 0 || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Pidiendo…" : "Pedir recuento"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
