import { Check, Minus, Plus } from "lucide-react"
import { useEffect, useState } from "react"

import { useSession } from "@/app/session"
import type { CatalogComboOut, CatalogProductOut } from "@/api/catalog"
import type { OrderChannel, OrderItemIn } from "@/api/orders"
import { Button } from "@/components/ui/button"
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
import { Textarea } from "@/components/ui/textarea"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { channelPriceKey, COURSE_LABEL, quickNotesFor } from "./lib"

export interface ItemDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  product?: CatalogProductOut | null
  combo?: CatalogComboOut | null
  channel: OrderChannel
  onConfirm: (item: OrderItemIn) => void
  pending?: boolean
  errorMessage?: string | null
  /**
   * Comensales de la mesa: el asiento se elige con botones 1…N. Sin el dato
   * (mostrador, o una mesa abierta sin comensales) queda el campo numérico.
   */
  seatCount?: number | null
  /**
   * El diálogo se abrió SÓLO porque el plato pide algo (un grupo
   * obligatorio): al completar un grupo obligatorio de una sola opción, si
   * no queda ningún otro obligatorio, el plato entra solo — sin el toque de
   * «Agregar». Con «Elegir opciones» (la persona quiere nota, asiento o
   * curso) no se usa: ahí el plato entra cuando ella lo dice.
   */
  autoAddOnRequired?: boolean
}

/**
 * Un renglón de opción de 56 px: todo el renglón es el objetivo táctil (la
 * casilla de 17 px de antes obligaba a apuntar). `role="checkbox"` porque se
 * prende y se apaga; en un grupo de una sola opción, elegir otra reemplaza
 * la anterior.
 */
const OPTION_CLASS =
  "flex min-h-14 w-full items-center gap-3 rounded-lg border p-3 text-left text-base transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"

/** Botón-ficha de 56 px: asiento, curso y notas rápidas. */
const CHIP_CLASS =
  "inline-flex min-h-14 items-center justify-center rounded-lg border px-4 text-base font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"

function chipState(active: boolean): string {
  return active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background hover:bg-muted"
}

function isRequiredGroup(group: { required: boolean; min: number }): boolean {
  return group.required || group.min > 0
}

/**
 * Un solo diálogo para agregar un producto o un combo a la comanda
 * (CONTRATO-INTERNO-1b-1.md, misión de `frontend-comanda`): cantidad,
 * modificadores con min/max/required (`pos.modifiers`), una opción por grupo
 * de combo (`pos.combos`), asiento (`pos.seats`), curso (`pos.courses`) y
 * nota. Todo con botones de 56 px: en la tablet del salón el teclado sólo
 * aparece para «Otra nota». Nunca calcula un total: sólo pinta precio de
 * lista y cada delta de modificador por separado (AGENTS.md § "una sola
 * matemática").
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
  seatCount = null,
  autoAddOnRequired = false,
}: ItemDialogProps): React.JSX.Element {
  const { hasFeature } = useSession()
  const [qty, setQty] = useState(1)
  const [note, setNote] = useState("")
  const [quickNotes, setQuickNotes] = useState<string[]>([])
  const [showOtherNote, setShowOtherNote] = useState(false)
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
    setQuickNotes([])
    setShowOtherNote(false)
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
  const modifierGroups = modifiersEnabled ? (product?.modifier_groups ?? []) : []
  const seatButtons = seatCount !== null && seatCount > 0 ? Array.from({ length: seatCount }, (_, i) => i + 1) : null
  const noteOptions = quickNotesFor(course || product?.default_course)

  function nextModifierSelection(
    prev: Record<number, number[]>,
    groupId: number,
    optionId: number,
    max: number,
  ): Record<number, number[]> {
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
  }

  function toggleModifierOption(groupId: number, optionId: number, max: number) {
    const next = nextModifierSelection(modifierSelection, groupId, optionId, max)
    setModifierSelection(next)
    // Completar el ÚNICO grupo obligatorio, de una sola opción, ya es todo lo
    // que el plato pedía: entra sin otro toque.
    const group = modifierGroups.find((g) => g.id === groupId)
    const otherRequired = modifierGroups.some((g) => g.id !== groupId && isRequiredGroup(g))
    const justChosen = (next[groupId] ?? []).includes(optionId)
    if (autoAddOnRequired && !pending && !combo && group && isRequiredGroup(group) && group.max === 1 && !otherRequired && justChosen) {
      handleConfirm(next)
    }
  }

  function toggleQuickNote(text: string) {
    setQuickNotes((prev) => (prev.includes(text) ? prev.filter((n) => n !== text) : [...prev, text]))
  }

  function handleConfirm(selection: Record<number, number[]> = modifierSelection) {
    setValidationError(null)

    if (modifiersEnabled) {
      for (const group of product?.modifier_groups ?? []) {
        const count = (selection[group.id] ?? []).length
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
      ? Object.values(selection)
          .flat()
          .map((optionId) => ({ option_id: optionId }))
      : undefined

    const comboSelections = combosEnabled && combo
      ? Object.entries(comboSelection).map(([groupId, optionId]) => ({ group_id: Number(groupId), option_id: optionId }))
      : undefined

    // Las notas rápidas y la escrita viajan juntas, en el orden en que se
    // tocaron: cocina lee una sola línea.
    const noteText = [...quickNotes, note.trim()].filter((part) => part !== "").join(", ")

    const body: OrderItemIn = {
      product_id: product?.id,
      combo_id: combo?.id,
      qty,
      seat: seatsEnabled && seat.trim() !== "" ? Number(seat) : undefined,
      course: coursesEnabled && course.trim() !== "" ? course : undefined,
      modifiers,
      combo_selections: comboSelections,
      note: noteText === "" ? undefined : noteText,
    }
    onConfirm(body)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
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
                className="size-14"
                aria-label="Restar una unidad"
                disabled={qty <= 1}
                onClick={() => setQty((q) => Math.max(1, q - 1))}
              >
                <Minus className="size-5" aria-hidden="true" />
              </Button>
              <span className="w-10 text-center text-lg font-semibold tabular-nums">{qty}</span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-14"
                aria-label="Sumar una unidad"
                onClick={() => setQty((q) => q + 1)}
              >
                <Plus className="size-5" aria-hidden="true" />
              </Button>
            </div>
          </div>

          {modifierGroups.map((group) => (
            <fieldset key={group.id} className="space-y-2">
              <legend className="text-sm font-medium">
                {group.name}
                {group.required ? " (obligatorio)" : " (opcional)"} —{" "}
                {group.min === group.max ? `elegí ${group.min}` : `entre ${group.min} y ${group.max}`}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {group.options.map((option) => {
                  const checked = (modifierSelection[group.id] ?? []).includes(option.id)
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      disabled={!option.available}
                      onClick={() => toggleModifierOption(group.id, option.id, group.max)}
                      className={cn(
                        OPTION_CLASS,
                        checked ? "border-primary bg-primary/10" : "border-border bg-background hover:bg-muted",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "grid size-6 shrink-0 place-items-center rounded-md border-2",
                          checked ? "border-primary bg-primary text-primary-foreground" : "border-input",
                        )}
                      >
                        {checked ? <Check className="size-4" /> : null}
                      </span>
                      <span className="flex-1 font-medium">{option.name}</span>
                      {option.price_delta !== 0 ? (
                        <span className="text-sm text-muted-foreground tabular-nums">
                          {option.price_delta > 0 ? "+" : ""}
                          {formatCOP(option.price_delta)}
                        </span>
                      ) : null}
                      {!option.available ? <span className="text-xs text-muted-foreground">Agotado</span> : null}
                    </button>
                  )
                })}
              </div>
            </fieldset>
          ))}

          {combosEnabled && combo
            ? combo.groups.map((group) => (
                <fieldset key={group.id} className="space-y-2">
                  <legend className="text-sm font-medium">{group.name} — elegí una opción</legend>
                  <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={group.name}>
                    {group.options.map((option) => (
                      <label
                        key={option.id}
                        className={`flex min-h-14 items-center gap-3 rounded-lg border p-3 text-base ${
                          !option.available_today ? "opacity-50" : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name={`combo-group-${group.id}`}
                          className="size-6 accent-primary"
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
            seatButtons ? (
              <div className="space-y-2">
                <p className="text-sm font-medium" id="item-seat-label">
                  Asiento (opcional)
                </p>
                {/* Uno por comensal de la mesa; tocar el elegido lo suelta. */}
                <div role="radiogroup" aria-labelledby="item-seat-label" className="flex flex-wrap gap-2">
                  {seatButtons.map((n) => {
                    const active = seat === String(n)
                    return (
                      <button
                        key={n}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={`Asiento ${n}`}
                        className={cn(CHIP_CLASS, "min-w-14 tabular-nums", chipState(active))}
                        onClick={() => setSeat(active ? "" : String(n))}
                      >
                        {n}
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : (
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
            )
          ) : null}

          {coursesEnabled ? (
            <div className="space-y-2">
              <p className="text-sm font-medium" id="item-course-label">
                Curso
              </p>
              {/* Arranca en el curso por defecto del plato: casi nunca se toca. */}
              <div role="radiogroup" aria-labelledby="item-course-label" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {Object.entries(COURSE_LABEL).map(([value, label]) => {
                  const active = course === value
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={cn(CHIP_CLASS, chipState(active))}
                      onClick={() => setCourse(value)}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="text-sm font-medium" id="item-notes-label">
              Nota (opcional)
            </p>
            <div role="group" aria-labelledby="item-notes-label" className="flex flex-wrap gap-2">
              {noteOptions.map((text) => {
                const active = quickNotes.includes(text)
                return (
                  <button
                    key={text}
                    type="button"
                    aria-pressed={active}
                    className={cn(CHIP_CLASS, chipState(active))}
                    onClick={() => toggleQuickNote(text)}
                  >
                    {text}
                  </button>
                )
              })}
              <button
                type="button"
                aria-pressed={showOtherNote}
                className={cn(CHIP_CLASS, chipState(showOtherNote))}
                onClick={() => setShowOtherNote((on) => !on)}
              >
                Otra nota
              </button>
            </div>
            {/* El teclado sólo aparece cuando se pide: las notas de siempre
                son un toque. */}
            {showOtherNote ? (
              <Textarea
                id="item-note"
                aria-label="Otra nota"
                autoFocus
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            ) : null}
          </div>

          {(validationError ?? errorMessage) ? (
            <p role="alert" className="text-sm text-destructive">
              {validationError ?? errorMessage}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" className="h-14 px-6 text-base font-semibold" disabled={pending} onClick={() => handleConfirm()}>
            {pending ? "Agregando…" : "Agregar a la comanda"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ItemDialog
