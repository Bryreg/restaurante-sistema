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

  it("al completar el único grupo obligatorio de una opción, el plato entra solo (sin «Agregar»)", async () => {
    const onConfirm = vi.fn()
    const product = buildCatalogProduct({
      modifier_groups: [
        {
          id: 1,
          product_id: 10,
          name: "Término",
          required: true,
          min: 1,
          max: 1,
          sort_order: 1,
          options: [
            { id: 1, name: "A punto", price_delta: 0, available: true },
            { id: 2, name: "Bien asado", price_delta: 0, available: true },
          ],
        },
        { id: 2, product_id: 10, name: "Adiciones", required: false, min: 0, max: 2, sort_order: 2, options: [] },
      ],
    })

    const user = userEvent.setup()
    renderWithProviders(
      <ItemDialog open product={product} channel="dine_in" autoAddOnRequired onOpenChange={vi.fn()} onConfirm={onConfirm} />,
      { me: deviceMe({ "pos.modifiers": true }) },
    )

    await user.click(screen.getByRole("checkbox", { name: /bien asado/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ product_id: 10, modifiers: [{ option_id: 2 }] }))
  })

  it("con dos grupos obligatorios no se adelanta: espera a que se completen y al «Agregar»", async () => {
    const onConfirm = vi.fn()
    const group = (id: number, name: string) => ({
      id,
      product_id: 10,
      name,
      required: true,
      min: 1,
      max: 1,
      sort_order: id,
      options: [{ id: id * 10, name: `${name} A`, price_delta: 0, available: true }],
    })
    const product = buildCatalogProduct({ modifier_groups: [group(1, "Término"), group(2, "Acompañante")] })

    const user = userEvent.setup()
    renderWithProviders(
      <ItemDialog open product={product} channel="dine_in" autoAddOnRequired onOpenChange={vi.fn()} onConfirm={onConfirm} />,
      { me: deviceMe({ "pos.modifiers": true }) },
    )

    await user.click(screen.getByRole("checkbox", { name: /término a/i }))
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("las notas rápidas son botones; el teclado sólo aparece con «Otra nota», y todo viaja en una línea", async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <ItemDialog open product={buildCatalogProduct({ default_course: "main" })} channel="dine_in" onOpenChange={vi.fn()} onConfirm={onConfirm} />,
      { me: deviceMe({}) },
    )

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Sin cebolla" }))
    await user.click(screen.getByRole("button", { name: "Aparte" }))
    await user.click(screen.getByRole("button", { name: "Otra nota" }))
    await user.type(screen.getByRole("textbox", { name: "Otra nota" }), "bien caliente")
    await user.click(screen.getByRole("button", { name: /agregar a la comanda/i }))

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ note: "Sin cebolla, Aparte, bien caliente" }))
  })

  it("el asiento se elige con botones 1…N según los comensales, y el curso con botones", async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <ItemDialog open product={buildCatalogProduct()} channel="dine_in" seatCount={3} onOpenChange={vi.fn()} onConfirm={onConfirm} />,
      { me: deviceMe({ "pos.seats": true, "pos.courses": true }) },
    )

    expect(screen.getAllByRole("radio", { name: /^asiento \d$/i })).toHaveLength(3)
    // El curso arranca en el del plato (bebida en el fixture).
    expect(screen.getByRole("radio", { name: "Bebida" })).toHaveAttribute("aria-checked", "true")
    await user.click(screen.getByRole("radio", { name: "Asiento 2" }))
    await user.click(screen.getByRole("radio", { name: "Postre" }))
    await user.click(screen.getByRole("button", { name: /agregar a la comanda/i }))

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ seat: 2, course: "dessert" }))
  })
})
