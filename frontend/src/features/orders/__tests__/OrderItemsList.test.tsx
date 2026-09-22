import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { OrderItemsList } from "../OrderItemsList"
import { buildOrderItem, deviceMe } from "./fixtures"

const noop = () => {}

/**
 * Abre el menú de acciones del renglón. Anular, cortesía y descuento viven
 * detrás de un solo botón desde que la línea se llevó a la forma de `m2b`:
 * sueltos no cabían en la columna de 384 px. Las pruebas los buscan por donde
 * los toca una persona, no en el DOM suelto — si no, «no está el botón» pasa
 * aunque la función esté, que es la peor clase de prueba en verde.
 */
async function abrirAcciones(): Promise<void> {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: /más acciones de/i }))
}

describe("OrderItemsList", () => {
  it("sin pos.courtesies el menú del renglón no ofrece Cortesía", async () => {
    renderWithProviders(
      <OrderItemsList items={[buildOrderItem()]} onIncrement={noop} onDecrement={noop} onVoid={noop} onCourtesy={noop} onDiscount={noop} />,
      { me: deviceMe({ "pos.courtesies": false }) },
    )

    await abrirAcciones()
    // El menú SÍ abrió —«Anular» está— y aun así no hay cortesía: la función
    // está apagada, no escondida detrás de un menú que no se abrió.
    expect(await screen.findByRole("menuitem", { name: /anular/i })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: /cortesía/i })).not.toBeInTheDocument()
  })

  it("con pos.courtesies el menú del renglón sí ofrece Cortesía en un ítem vivo", async () => {
    renderWithProviders(
      <OrderItemsList items={[buildOrderItem()]} onIncrement={noop} onDecrement={noop} onVoid={noop} onCourtesy={noop} onDiscount={noop} />,
      { me: deviceMe({ "pos.courtesies": true }) },
    )

    await abrirAcciones()
    expect(await screen.findByRole("menuitem", { name: /cortesía/i })).toBeInTheDocument()
  })

  it("la cantidad sólo es editable en pending; un ítem ya en cocina igual la muestra", () => {
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

    // La cantidad se ve igual en el renglón que ya salió a cocina: en `m2b`
    // vive en su recuadro de la primera columna, a la misma altura en todos
    // los renglones. Perder de vista cuántos son cuando el plato ya se mandó
    // es justo cuando más importa —es lo que se compara contra la mesa—.
    const sopa = screen.getByText("Sopa").closest("li")
    expect(sopa).not.toBeNull()
    expect(within(sopa as HTMLElement).getByText("1")).toBeInTheDocument()
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

    // Un renglón anulado no tiene menú: no hay nada que hacerle.
    expect(screen.queryByRole("button", { name: /más acciones de/i })).not.toBeInTheDocument()
    expect(screen.getByText(/se fue sin pagar/i)).toBeInTheDocument()
  })
})
