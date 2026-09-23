import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { OrderItemsList } from "../OrderItemsList"
import { buildOrderItem, deviceMe } from "./fixtures"

const noop = () => {}

describe("OrderItemsList", () => {
  it("sin pos.courtesies no muestra el botón Cortesía", () => {
    renderWithProviders(
      <OrderItemsList items={[buildOrderItem()]} onIncrement={noop} onDecrement={noop} onVoid={noop} onCourtesy={noop} onDiscount={noop} />,
      { me: deviceMe({ "pos.courtesies": false }) },
    )

    expect(screen.queryByRole("button", { name: /cortesía/i })).not.toBeInTheDocument()
  })

  it("con pos.courtesies sí muestra el botón Cortesía en un ítem vivo", () => {
    renderWithProviders(
      <OrderItemsList items={[buildOrderItem()]} onIncrement={noop} onDecrement={noop} onVoid={noop} onCourtesy={noop} onDiscount={noop} />,
      { me: deviceMe({ "pos.courtesies": true }) },
    )

    expect(screen.getByRole("button", { name: /cortesía/i })).toBeInTheDocument()
  })

  it("la cantidad sólo es editable en pending; un ítem enviado la muestra como texto", () => {
    const onIncrement = vi.fn()
    renderWithProviders(
      <OrderItemsList
        items={[buildOrderItem({ id: 1, status: "pending" }), buildOrderItem({ id: 2, status: "sent", name: "Sopa" })]}
        onIncrement={onIncrement}
        onDecrement={noop}
        onVoid={noop}
        onCourtesy={noop}
        onDiscount={noop}
      />,
      { me: deviceMe({}) },
    )

    expect(screen.getByRole("button", { name: /sumar una unidad de limonada de coco/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /restar una unidad de sopa/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /sumar una unidad de sopa/i })).not.toBeInTheDocument()
    // La cantidad del enviado queda como texto («1×») en su línea.
    const sentLine = screen.getByText("Sopa").closest("li") as HTMLElement
    expect(within(sentLine).getByText("1×")).toBeInTheDocument()
  })

  it("un ítem anulado no ofrece anular de nuevo", () => {
    renderWithProviders(
      <OrderItemsList
        items={[buildOrderItem({ status: "voided", void: { reason: "walkout", note: null, by: { id: 2, name: "Ana" }, authorized_by: null, at: "2026-09-15T18:10:00Z", after_bill: false, minutes_since_sent: null } })]}
        onIncrement={noop}
        onDecrement={noop}
        onVoid={noop}
        onCourtesy={noop}
        onDiscount={noop}
      />,
      { me: deviceMe({ "pos.courtesies": true, "pos.discounts": true }) },
    )

    expect(screen.queryByRole("button", { name: /^anular/i })).not.toBeInTheDocument()
    expect(screen.getByText(/se fue sin pagar/i)).toBeInTheDocument()
  })

  it("separa lo enviado de la ronda sin enviar y agrupa cada ronda por curso", () => {
    renderWithProviders(
      <OrderItemsList
        items={[
          buildOrderItem({ id: 1, name: "Sopa de guineo", course: "starter", status: "sent", round_no: 1 }),
          buildOrderItem({ id: 2, name: "Bandeja paisa", course: "main", qty: 2, net: 76000 }),
          buildOrderItem({ id: 3, name: "Limonada de coco", course: "beverage", qty: 3, net: 27000 }),
        ]}
        nextRoundNo={2}
        onIncrement={noop}
        onDecrement={noop}
        onVoid={noop}
        onCourtesy={noop}
        onDiscount={noop}
      />,
      { me: deviceMe({}) },
    )

    const sent = screen.getByRole("region", { name: "Ronda 1 · enviada" })
    expect(within(sent).getByText("Sopa de guineo")).toBeInTheDocument()
    expect(within(sent).getByText("Entradas")).toBeInTheDocument()
    expect(within(sent).queryByText("Bandeja paisa")).not.toBeInTheDocument()

    const unsent = screen.getByRole("region", { name: "Ronda 2 · sin enviar" })
    expect(within(unsent).queryByText("Sopa de guineo")).not.toBeInTheDocument()
    // Rótulos de curso en orden de salida: bebidas antes que fuertes.
    const labels = within(unsent).getAllByText(/^(Bebidas|Fuertes)$/).map((el) => el.textContent)
    expect(labels).toEqual(["Bebidas", "Fuertes"])
    const bandeja = within(unsent).getByText("Bandeja paisa").closest("li") as HTMLElement
    expect(within(bandeja).getByText("2×")).toBeInTheDocument()
    // El monto de la línea es el `net` del backend, tal cual.
    expect(within(bandeja).getByText(/76\.000/)).toBeInTheDocument()
  })

  it("los modificadores, las opciones del combo y la nota van en línea, debajo del nombre", () => {
    renderWithProviders(
      <OrderItemsList
        items={[
          buildOrderItem({
            id: 1,
            name: "Pechuga a la plancha",
            course: "main",
            modifiers_text: "+ papa criolla, sin cebolla",
            note: "bien asada",
          }),
          buildOrderItem({
            id: 2,
            name: "Menú ejecutivo",
            product_id: null,
            combo_id: 20,
            course: "main",
            combo_selections: [{ group_id: 1, group_name: "Plato fuerte", option_id: 100, product_id: 10, product_name: "Pollo" }],
          }),
        ]}
        onIncrement={noop}
        onDecrement={noop}
        onVoid={noop}
        onCourtesy={noop}
        onDiscount={noop}
      />,
      { me: deviceMe({}) },
    )

    const pechuga = screen.getByText("Pechuga a la plancha").closest("li") as HTMLElement
    expect(within(pechuga).getByText("+ papa criolla, sin cebolla")).toBeInTheDocument()
    expect(within(pechuga).getByText("Nota: bien asada")).toBeInTheDocument()
    const combo = screen.getByText("Menú ejecutivo").closest("li") as HTMLElement
    expect(within(combo).getByText("Pollo")).toBeInTheDocument()
    // En línea: ningún diálogo aparte para leerlos.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})
