import { useState } from "react"

import type {
  BaseUnit,
  PreparationAdminOut,
  PreparationIn,
  PreparationUpdateIn,
  PrepMode,
} from "@/api/recipes"
import { FormField, FormSection } from "@/components/admin"
import { Button } from "@/components/ui/button"
import { DialogClose, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

import {
  ComponentLinesEditor,
  componentLinesToDrafts,
  draftsToComponentLines,
  emptyLine,
  type LineDraft,
  type LineIngredientOption,
  type LinePreparationOption,
} from "./ComponentLinesEditor"

export interface PreparationFormValues {
  name: string
  mode: PrepMode
  standardYieldQty: string
  standardYieldUnit: BaseUnit
  processLossPct: number
  shelfLifeDays: number | null
  lines: LineDraft[]
}

function toFormValues(preparation?: PreparationAdminOut): PreparationFormValues {
  return {
    name: preparation?.name ?? "",
    mode: preparation?.mode ?? "exploded",
    standardYieldQty: preparation?.standard_yield_qty ?? "1",
    standardYieldUnit: (preparation?.standard_yield_unit as BaseUnit) ?? "g",
    processLossPct: preparation?.process_loss_pct ?? 0,
    shelfLifeDays: preparation?.shelf_life_days ?? null,
    lines: preparation ? componentLinesToDrafts(preparation.lines) : [emptyLine()],
  }
}

export function formValuesToPreparationIn(values: PreparationFormValues): PreparationIn {
  return {
    name: values.name,
    mode: values.mode,
    standard_yield_qty: values.standardYieldQty,
    standard_yield_unit: values.standardYieldUnit,
    process_loss_pct: values.processLossPct,
    shelf_life_days: values.shelfLifeDays,
    lines: draftsToComponentLines(values.lines),
  }
}

export function formValuesToPreparationUpdateIn(values: PreparationFormValues): PreparationUpdateIn {
  return {
    name: values.name,
    standard_yield_qty: values.standardYieldQty,
    standard_yield_unit: values.standardYieldUnit,
    process_loss_pct: values.processLossPct,
    shelf_life_days: values.shelfLifeDays,
    lines: draftsToComponentLines(values.lines),
  }
}

const UNIT_WORD: Record<BaseUnit, string> = { g: "g", ml: "ml", unit: "unidades" }

/**
 * Alta y edición de una preparación (spec §4.2 / §9.3, patrón 9). El modo NO
 * se edita acá: sólo se elige al crear — cambiarlo después es una acción
 * aparte de administrador con PIN (`PrepModeSwitchDialog`), porque salir de
 * `batch` cierra lotes abiertos y eso necesita su propia confirmación
 * explícita. La lectura de la primera sección lo dice con todas las letras
 * en vez de dejar al dueño descubrirlo cuando el desplegable no esté.
 *
 * Ninguna ayuda de acá calcula nada: el rendimiento neto, el costo por
 * unidad y la varianza los deriva el backend (AGENTS.md, «una sola
 * matemática»). Las lecturas repiten en palabras lo que los campos dicen.
 */
export function PreparationForm({
  preparation,
  ingredients,
  preparations,
  onSubmit,
  submitting,
  submitLabel,
}: {
  preparation?: PreparationAdminOut
  ingredients: LineIngredientOption[]
  preparations: LinePreparationOption[]
  onSubmit: (values: PreparationFormValues) => void
  submitting: boolean
  submitLabel: string
}): React.JSX.Element {
  const [values, setValues] = useState<PreparationFormValues>(() => toFormValues(preparation))
  const isEdit = preparation !== undefined
  const hasCompleteLine = values.lines.some(
    (line) => (line.ingredientId !== null || line.preparationId !== null) && line.qty.trim() !== ""
  )

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(values)
      }}
    >
      <FormSection
        title="Qué es y cómo descuenta sus insumos"
        governs="El nombre con el que la cocina la pide y el modo con el que el sistema le baja el stock a lo que lleva adentro."
        reading={
          isEdit ? (
            <>
              Está en modo <b>{preparation.mode === "batch" ? "Por lote" : "Explotada"}</b>. El modo no se
              cambia desde acá: usá «Cambiar modo» en la lista, que pide PIN de administrador porque salir de
              «por lote» cierra los lotes abiertos.
            </>
          ) : values.mode === "batch" ? (
            <>
              En <b>por lote</b>, esta preparación lleva stock propio: alguien tiene que producirla para que
              exista. Si nadie la produce, queda en negativo y el costo de los platos que la usan se va a las
              nubes.
            </>
          ) : (
            <>
              En <b>explotada</b>, al enviar un plato que la usa se descuentan directo los insumos de su
              receta. No lleva stock propio y no hay nada que producir.
            </>
          )
        }
        doesNotDo="Crear una preparación no descuenta nada por sí misma: lo que mueve inventario es venderla (explotada) o producirla (por lote)."
      >
        <FormField
          label="Nombre"
          help="Con el que la va a pedir la cocina y con el que aparece dentro de la receta de cada plato."
        >
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              required
              value={values.name}
              onChange={(event) => setValues((v) => ({ ...v, name: event.target.value }))}
            />
          )}
        </FormField>

        {isEdit ? null : (
          <FormField
            label="Modo"
            help="«Explotada» es el default. Usá «por lote» sólo para lo caro, perecedero o vendido por porción — y produciéndolo de verdad."
            scope={{ affects: [{ screen: "Salón › Producir" }], requires: "PIN de administrador para cambiarlo" }}
          >
            {({ fieldId, describedBy }) => (
              <Select
                value={values.mode}
                onValueChange={(value) => setValues((v) => ({ ...v, mode: value as PrepMode }))}
              >
                <SelectTrigger id={fieldId} aria-describedby={describedBy} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="exploded">Explotada (default): sin stock, descuenta al enviar el plato</SelectItem>
                  <SelectItem value="batch">Por lote: hay que producirla, crea stock con vencimiento</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>
        )}
      </FormSection>

      <FormSection
        title="Cuánto rinde y cuánto dura"
        governs="La tanda estándar: con esto el sistema valora el costo por unidad y sabe cuándo un lote venció."
        reading={
          <>
            Una tanda estándar rinde <b>{values.standardYieldQty || "—"} {UNIT_WORD[values.standardYieldUnit]}</b>,
            con una merma esperada de <b>{values.processLossPct} %</b>
            {values.shelfLifeDays === null ? (
              <>, y no vence.</>
            ) : (
              <>
                , y vence a los <b>{values.shelfLifeDays} días</b> de producida.
              </>
            )}{" "}
            El costo por unidad lo calcula el servidor con la receta de abajo: acá no se deriva ningún número.
          </>
        }
      >
        <FormField
          label="Rendimiento estándar"
          help="Cuánto sale de una tanda. Es el denominador del costo por unidad: si está mal, el costo de cada plato que la use está mal."
        >
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              inputMode="decimal"
              required
              value={values.standardYieldQty}
              onChange={(event) => setValues((v) => ({ ...v, standardYieldQty: event.target.value }))}
            />
          )}
        </FormField>

        <FormField label="Unidad" help="En la que se mide lo que sale, y en la que las recetas la van a pedir.">
          {({ fieldId, describedBy }) => (
            <Select
              value={values.standardYieldUnit}
              onValueChange={(value) => setValues((v) => ({ ...v, standardYieldUnit: value as BaseUnit }))}
            >
              <SelectTrigger id={fieldId} aria-describedby={describedBy} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="g">g</SelectItem>
                <SelectItem value="ml">ml</SelectItem>
                <SelectItem value="unit">unidad</SelectItem>
              </SelectContent>
            </Select>
          )}
        </FormField>

        <FormField
          label="Merma de proceso (%)"
          help="Lo que se pierde al cocinar, colar o porcionar. Entra al costo: lo que se pierde también se pagó."
        >
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              type="number"
              min={0}
              max={100}
              value={values.processLossPct}
              onChange={(event) => setValues((v) => ({ ...v, processLossPct: Number(event.target.value) }))}
            />
          )}
        </FormField>

        <FormField
          label="Vida útil (días)"
          help="Vacío es «no vence», que no es lo mismo que cero días. Con un número, cada lote producido nace con su fecha de vencimiento."
        >
          {({ fieldId, describedBy }) => (
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              type="number"
              min={0}
              placeholder="Sin vencer"
              value={values.shelfLifeDays ?? ""}
              onChange={(event) =>
                setValues((v) => ({
                  ...v,
                  shelfLifeDays: event.target.value === "" ? null : Number(event.target.value),
                }))
              }
            />
          )}
        </FormField>
      </FormSection>

      <FormSection
        title="Receta propia (insumos y/u otras preparaciones)"
        governs="Lo que lleva adentro una tanda estándar. De acá sale el costo, y de acá se descuenta el stock cuando se produce o se vende."
        columns="one"
        reading={
          hasCompleteLine ? (
            <>
              El servidor valora la tanda con estos componentes. Si alguno no tiene costo conocido, la
              preparación queda <b>«sin costo»</b> — que no es <b>$ 0</b>: es que no se pudo valorar.
            </>
          ) : (
            <>
              Todavía no hay ninguna línea completa. Una preparación <b>sin componentes no tiene costo</b> y
              arrastra a cero el costo aparente de todo plato que la use.
            </>
          )
        }
      >
        <ComponentLinesEditor
          idPrefix="prep"
          lines={values.lines}
          onChange={(lines) => setValues((v) => ({ ...v, lines }))}
          ingredients={ingredients}
          preparations={preparations}
          excludePreparationId={preparation?.id}
        />
      </FormSection>

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancelar</DialogClose>
        <Button type="submit" disabled={submitting || values.name.trim() === "" || !hasCompleteLine}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}
