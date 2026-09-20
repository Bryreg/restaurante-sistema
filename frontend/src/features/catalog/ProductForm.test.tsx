import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { Dialog, DialogContent } from "@/components/ui/dialog"
import { renderWithProviders } from "@/test/utils"

import { formValuesToProductIn, formValuesToProductUpdateIn, ProductForm } from "./ProductForm"

const CATEGORIES = [{ id: 1, name: "Platos fuertes" }]

/** `ProductForm` usa `DialogClose` (el botón "Cancelar"): necesita el
 * contexto de `Dialog.Root`, igual que en `ProductsTab.tsx`. */
function renderForm(props: Omit<Parameters<typeof ProductForm>[0], never>) {
  return renderWithProviders(
    <Dialog open>
      <DialogContent>
        <ProductForm {...props} />
      </DialogContent>
    </Dialog>,
  )
}

/**
 * SPEC-NEGOCIO §4.3, AGENTS.md "`null` ≠ 0": un canal opcional vacío tiene
 * que decirlo sin ambigüedad ("Igual que mesa") y mandarse como `null`,
 * nunca como `0` — mandar `0` regalaría el producto.
 */
describe("ProductForm — precio por canal", () => {
  it("mesa es obligatorio; para llevar, domicilio y plataforma dicen 'Igual que mesa' cuando están vacíos", async () => {
    renderForm({ categories: CATEGORIES, onSubmit: vi.fn(), submitting: false, submitLabel: "Crear" })

    expect(screen.getByLabelText(/mesa \(obligatorio\)/i)).toBeRequired()
    expect(screen.getByLabelText("Para llevar")).toHaveAttribute("placeholder", "Igual que mesa")
    expect(screen.getByLabelText("Domicilio")).toHaveAttribute("placeholder", "Igual que mesa")
    expect(screen.getByLabelText("Plataforma")).toHaveAttribute("placeholder", "Igual que mesa")
  })

  it("un canal opcional vacío se manda como null, nunca como 0", () => {
    const values = {
      categoryId: 1,
      name: "Bandeja paisa",
      description: "",
      station: "",
      defaultCourse: "",
      dineIn: 38_000,
      takeout: null,
      delivery: null,
      platform: null,
      taxCode: "" as const,
      dailyCount: null,
      isDeliveryFee: false,
    }

    expect(formValuesToProductIn(values).prices).toEqual({
      dine_in: 38_000,
      takeout: null,
      delivery: null,
      platform: null,
    })
    expect(formValuesToProductUpdateIn(values).prices).toEqual({
      dine_in: 38_000,
      takeout: null,
      delivery: null,
      platform: null,
    })
  })

  it("marcar 'es el cargo de domicilio' lo manda como is_delivery_fee: true", async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    renderForm({ categories: CATEGORIES, onSubmit, submitting: false, submitLabel: "Crear" })

    await user.type(screen.getByLabelText("Nombre"), "Cargo de domicilio")
    await user.click(screen.getByLabelText("Categoría"))
    await user.click(await screen.findByRole("option", { name: "Platos fuertes" }))
    await user.click(screen.getByRole("checkbox", { name: /es el cargo de domicilio de esta sede/i }))
    await user.type(screen.getByLabelText(/mesa \(obligatorio\)/i), "5.000")
    await user.click(screen.getByRole("button", { name: "Crear" }))

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ isDeliveryFee: true }))
    expect(formValuesToProductIn(onSubmit.mock.calls[0][0]).is_delivery_fee).toBe(true)
  })
})
