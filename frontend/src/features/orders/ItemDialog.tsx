import { Minus, Plus } from "lucide-react"
import { useEffect, useState } from "react"

import { useSession } from "@/app/session"
import type { CatalogComboOut, CatalogProductOut } from "@/api/catalog"
import type { OrderChannel, OrderItemIn } from "@/api/orders"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { formatCOP } from "@/lib/money"

import { channelPriceKey, COURSE_LABEL } from "./lib"

export interface ItemDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  product?: CatalogProductOut | null
  combo?: CatalogComboOut | null
  channel: OrderChannel
  onConfirm: (item: OrderItemIn) => void
  pending?: boolean
  errorMessage?: string | null
}

/**
 * Un solo diálogo para agregar un producto o un combo a la comanda
 * (CONTRATO-INTERNO-1b-1.md, misión de `frontend-comanda`): cantidad,
 * modificadores con min/max/required (`pos.modifiers`), una opción por grupo
 * de combo (`pos.combos`), asiento (`pos.seats`), curso (`pos.courses`) y
 * nota. Nunca calcula un total: sólo pinta precio de lista y cada delta de
 * modificador por separado (AGENTS.md § "una sola matemática").
 */
export function ItemDialog({
  open,
  onOpenChange,
  product = null,
  combo = null,
  channel,
  onConfirm,
  pending = false,
  errorMessage = null,
}: ItemDialogProps): React.JSX.Element {
  const { hasFeature } = useSession()
  const [qty, setQty] = useState(1)
  const [note, setNote] = useState("")
  const [seat, setSeat] = useState("")
  const [course, setCourse] = useState("")
  const [modifierSelection, setModifierSelection] = useState<Record<number, number[]>>({})
  const [comboSelection, setComboSelection] = useState<Record<number, number>>({})
  const [validationError, setValidationError] = useState<string | null>(null)

  const item = product ?? combo
  const modifiersEnabled = hasFeature("pos.modifiers")
  const combosEnabled = hasFeature("pos.combos")
  const seatsEnabled = hasFeature("pos.seats")
  const coursesEnabled = hasFeature("pos.courses")

  useEffect(() => {
    if (!open) return
    setQty(1)
    setNote("")
    setSeat("")
    setCourse(product?.default_course ?? "")
    setModifierSelection({})
    setComboSelection({})
    setValidationError(null)
  }, [open, product, combo])

  if (!item) {
    return <Dialog open={open} onOpenChange={onOpenChange} />
  }

  const priceKey = channelPriceKey(channel)
  const listPrice = product ? product.prices[priceKey] : combo?.price

  function toggleModifierOption(groupId: number, optionId: number, max: number) {
    setModifierSelection((prev) => {
      const current = prev[groupId] ?? []
      if (current.includes(optionId)) {
        return { ...prev, [groupId]: current.filter((id) => id !== optionId) }
      }
      if (max === 1) {
        return { ...prev, [groupId]: [optionId] }
      }
      if (current.length >= max) {
        return prev
      }
      return { ...prev, [groupId]: [...current, optionId] }
    })
  }

  function handleConfirm() {
    setValidationError(null)

    if (modifiersEnabled) {
      for (const group of product?.modifier_groups ?? []) {
        const count = (modifierSelection[group.id] ?? []).length
        if (count < group.min || count > group.max) {
          setValidationError(`"${group.name}" necesita entre ${group.min} y ${group.max} opciones.`)
          return
        }
      }
    }

    if (combosEnabled && combo) {
      for (const group of combo.groups) {
        if (comboSelection[group.id] === undefined) {
          setValidationError(`Elegí una opción de "${group.name}".`)
          return
        }
      }
    }

    const modifiers = modifiersEnabled
      ? Object.values(modifierSelection)
          .flat()
          .map((optionId) => ({ option_id: optionId }))
      : undefined

    const comboSelections = combosEnabled && combo
      ? Object.entries(comboSelection).map(([groupId, optionId]) => ({ group_id: Number(groupId), option_id: optionId }))
      : undefined

    const body: OrderItemIn = {
      product_id: product?.id,
      combo_id: combo?.id,
      qty,
      seat: seatsEnabled && seat.trim() !== "" ? Number(seat) : undefined,
      course: coursesEnabled && course.trim() !== "" ? course : undefined,
      modifiers,
      combo_selections: comboSelections,
      note: note.trim() === "" ? undefined : note.trim(),
    }
    onConfirm(body)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
          <DialogDescription>{formatCOP(listPrice)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <Label className="shrink-0">Cantidad</Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11"
                aria-label="Restar una unidad"
                disabled={qty <= 1}
                onClick={() => setQty((q) => Math.max(1, q - 1))}
              >
                <Minus className="size-4" aria-hidden="true" />
              </Button>
              <span className="w-8 text-center text-base font-medium tabular-nums">{qty}</span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11"
                aria-label="Sumar una unidad"
                onClick={() => setQty((q) => q + 1)}
              >
                <Plus className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          {modifiersEnabled && product?.modifier_groups?.length
            ? product.modifier_groups.map((group) => (
                <fieldset key={group.id} className="space-y-2">
                  <legend className="text-sm font-medium">
                    {group.name}
                    {group.required ? " (obligatorio)" : " (opcional)"} — {group.min === group.max ? `elegí ${group.min}` : `entre ${group.min} y ${group.max}`}
                  </legend>
                  <div className="space-y-1">
                    {group.options.map((option) => {
                      const checked = (modifierSelection[group.id] ?? []).includes(option.id)
                      return (
                        <label
                          key={option.id}
                          className={`flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm ${
                            !option.available ? "opacity-50" : ""
                          }`}
                        >
                          <Checkbox
                            checked={checked}
                            disabled={!option.available}
                            onCheckedChange={() => toggleModifierOption(group.id, option.id, group.max)}
                          />
                          <span className="flex-1">{option.name}</span>
                          {option.price_delta !== 0 ? (
                            <span className="text-muted-foreground">
                              {option.price_delta > 0 ? "+" : ""}
                              {formatCOP(option.price_delta)}
                            </span>
                          ) : null}
                          {!option.available ? <span className="text-xs text-muted-foreground">Agotado</span> : null}
                        </label>
                      )
                    })}
                  </div>
                </fieldset>
              ))
            : null}

          {combosEnabled && combo
            ? combo.groups.map((group) => (
                <fieldset key={group.id} className="space-y-2">
                  <legend className="text-sm font-medium">{group.name} — elegí una opción</legend>
                  <div className="space-y-1" role="radiogroup" aria-label={group.name}>
                    {group.options.map((option) => (
                      <label
                        key={option.id}
                        className={`flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm ${
                          !option.available_today ? "opacity-50" : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name={`combo-group-${group.id}`}
                          className="size-4"
                          checked={comboSelection[group.id] === option.id}
                          disabled={!option.available_today}
                          onChange={() => setComboSelection((prev) => ({ ...prev, [group.id]: option.id }))}
                          aria-label={option.name}
                        />
                        <span className="flex-1">{option.name}</span>
                        {!option.available_today ? <span className="text-xs text-muted-foreground">Agotado</span> : null}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))
            : null}

          {seatsEnabled ? (
            <div className="space-y-1">
              <Label htmlFor="item-seat">Asiento (opcional)</Label>
              <Input
                id="item-seat"
                type="number"
                min={1}
                className="h-11"
                value={seat}
                onChange={(event) => setSeat(event.target.value)}
              />
            </div>
          ) : null}

          {coursesEnabled ? (
            <div className="space-y-1">
              <Label htmlFor="item-course">Curso</Label>
              <Select value={course === "" ? undefined : course} onValueChange={(value) => setCourse(value ?? "")}>
                <SelectTrigger id="item-course" className="h-11 w-full">
                  <SelectValue placeholder="Por defecto del producto" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(COURSE_LABEL).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-1">
            <Label htmlFor="item-note">Nota (opcional)</Label>
            <Textarea id="item-note" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>

          {(validationError ?? errorMessage) ? (
            <p role="alert" className="text-sm text-destructive">
              {validationError ?? errorMessage}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" className="h-11" disabled={pending} onClick={handleConfirm}>
            {pending ? "Agregando…" : "Agregar a la comanda"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ItemDialog
