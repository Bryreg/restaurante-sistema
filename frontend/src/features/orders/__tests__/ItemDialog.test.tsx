import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { ItemDialog } from "../ItemDialog"
import { buildCatalogProduct, deviceMe } from "./fixtures"

describe("ItemDialog", () => {
  it("sin pos.seats no muestra el campo de asiento", () => {
    renderWithProviders(
      <ItemDialog open product={buildCatalogProduct()} channel="dine_in" onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
      { me: deviceMe({ "pos.seats": false }) },
    )

    expect(screen.queryByLabelText(/asiento/i)).not.toBeInTheDocument()
  })

  it("con pos.seats muestra el campo de asiento", () => {
    renderWithProviders(
      <ItemDialog open product={buildCatalogProduct()} channel="dine_in" onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
      { me: deviceMe({ "pos.seats": true }) },
    )

    expect(screen.getByLabelText(/asiento/i)).toBeInTheDocument()
  })

  it("exige elegir modificadores requeridos antes de confirmar (pos.modifiers)", async () => {
    const onConfirm = vi.fn()
    const product = buildCatalogProduct({
      modifier_groups: [
        {
          id: 1,
          product_id: 10,
          name: "Tamaño",
          required: true,
          min: 1,
          max: 1,
          sort_order: 1,
          options: [
            { id: 1, name: "Grande", price_delta: 2000, available: true },
            { id: 2, name: "Pequeño", price_delta: 0, available: true },
          ],
        },
      ],
    })

    const user = userEvent.setup()
    renderWithProviders(
      <ItemDialog open product={product} channel="dine_in" onOpenChange={vi.fn()} onConfirm={onConfirm} />,
      { me: deviceMe({ "pos.modifiers": true }) },
    )

    await user.click(screen.getByRole("button", { name: /agregar a la comanda/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/tamaño/i)
    expect(onConfirm).not.toHaveBeenCalled()

    await user.click(screen.getByRole("checkbox", { name: /grande/i }))
    await user.click(screen.getByRole("button", { name: /agregar a la comanda/i }))

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ product_id: 10, qty: 1, modifiers: [{ option_id: 1 }] }),
    )
  })

  it("un producto sin flag de modificadores no manda modifiers aunque el producto tenga grupos", async () => {
    const onConfirm = vi.fn()
    const product = buildCatalogProduct({
      modifier_groups: [{ id: 1, product_id: 10, name: "Tamaño", required: true, min: 1, max: 1, sort_order: 1, options: [] }],
    })

    const user = userEvent.setup()
    renderWithProviders(
      <ItemDialog open product={product} channel="dine_in" onOpenChange={vi.fn()} onConfirm={onConfirm} />,
      { me: deviceMe({ "pos.modifiers": false }) },
    )

    expect(screen.queryByText("Tamaño")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /agregar a la comanda/i }))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ modifiers: undefined }))
  })
})
