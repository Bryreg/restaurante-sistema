import { screen } from "@testing-library/react"
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
    expect(screen.queryByRole("button", { name: /sumar una unidad de sopa/i })).not.toBeInTheDocument()
    expect(screen.getByText("Cant. 1")).toBeInTheDocument()
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
})
