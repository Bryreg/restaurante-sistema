import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { Dialog, DialogContent } from "@/components/ui/dialog"

import { formValuesToIngredientIn, IngredientForm, minStockValid } from "../IngredientForm"

/** `IngredientForm` usa `DialogClose`/`DialogFooter` (mismo patrón que
 * `PreparationForm.tsx`, territorio de `frontend-recetas`): fuera de un
 * `<Dialog>` real, `DialogClose` no encuentra su contexto — se envuelve acá
 * para probar el formulario solo, sin abrir todo `IngredientsTab`. */
function renderForm(props: Omit<Parameters<typeof IngredientForm>[0], never>) {
  return render(
    <Dialog open>
      <DialogContent>
        <IngredientForm {...props} />
      </DialogContent>
    </Dialog>,
  )
}

describe("minStockValid", () => {
  it("rechaza vacío, cero y negativo — SPEC-NEGOCIO §4.1: nunca un umbral en cero", () => {
    expect(minStockValid("")).toBe(false)
    expect(minStockValid("0")).toBe(false)
    expect(minStockValid("-5")).toBe(false)
    expect(minStockValid("abc")).toBe(false)
  })

  it("acepta cualquier valor mayor que cero", () => {
    expect(minStockValid("1")).toBe(true)
    expect(minStockValid("0.5")).toBe(true)
    expect(minStockValid("1000")).toBe(true)
  })
})

describe("formValuesToIngredientIn", () => {
  it("manda min_stock como string decimal, nunca number JSON, y campos vacíos como null", () => {
    const body = formValuesToIngredientIn({
      name: "Papa criolla",
      category: "",
      baseUnit: "g",
      purchaseUnit: "bulto",
      purchaseFactor: "25000",
      yieldPct: "85",
      officialCost: "",
      estimatedCost: "3500.50",
      minStock: "1000",
      leadTimeDays: "",
      perishable: true,
      keyItem: false,
      consumptionUntracked: false,
      substituteIngredientId: null,
      active: true,
    })

    expect(body.min_stock).toBe("1000")
    expect(typeof body.min_stock).toBe("string")
    expect(body.estimated_cost).toBe("3500.50")
    expect(body.official_cost).toBeNull()
    expect(body.category).toBeNull()
    expect(body.lead_time_days).toBeNull()
    expect(body.yield_pct).toBe(85)
  })
})

describe("IngredientForm — min_stock obligatorio y mayor que cero (validado en el cliente)", () => {
  it("el submit queda deshabilitado con min_stock en 0, y se habilita al corregirlo", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()

    renderForm({ otherIngredients: [], submitting: false, submitLabel: "Crear", onSubmit })

    await user.type(screen.getByLabelText("Nombre"), "Papa criolla")
    await user.type(screen.getByLabelText("Unidad de compra"), "bulto")

    const minStockInput = screen.getByLabelText("Umbral de stock mínimo")
    await user.type(minStockInput, "0")
    expect(screen.getByText(/tiene que ser mayor que cero/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Crear" })).toBeDisabled()

    await user.clear(minStockInput)
    await user.type(minStockInput, "1000")
    expect(screen.getByRole("button", { name: "Crear" })).toBeEnabled()

    await user.click(screen.getByRole("button", { name: "Crear" }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("muestra el `400 MIN_STOCK_REQUIRED` del servidor tal cual si igual llega", () => {
    renderForm({
      otherIngredients: [],
      submitting: false,
      submitLabel: "Crear",
      onSubmit: vi.fn(),
      serverError: "min_stock: definí un umbral mínimo mayor a cero; sin él, el motor de alertas de este insumo queda apagado",
    })

    expect(screen.getByRole("alert")).toHaveTextContent(/motor de alertas de este insumo queda apagado/i)
  })
})
