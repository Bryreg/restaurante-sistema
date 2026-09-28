import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { OrderItemsList } from "../OrderItemsList"
import { buildOrderItem, deviceMe } from "./fixtures"

const noop = () => {}

describe("OrderItemsList", () => {
  it("sin pos.courtesies el panel de la línea no ofrece Cortesía, ni siquiera en «Más»", async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <OrderItemsList items={[buildOrderItem()]} onIncrement={noop} onDecrement={noop} onVoid={noop} onCourtesy={noop} onDiscount={noop} />,
      { me: deviceMe({ "pos.courtesies": false }) },
    )

    await user.click(screen.getByRole("button", { name: /limonada de coco: acciones/i }))
    await screen.findByRole("dialog")
    expect(screen.queryByRole("button", { name: /^más$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /cortesía/i })).not.toBeInTheDocument()
  })

  it("la línea es un solo renglón: sus acciones no están a la vista hasta tocarla", () => {
    renderWithProviders(
      <OrderItemsList items={[buildOrderItem()]} onIncrement={noop} onDecrement={noop} onVoid={noop} onCourtesy={noop} onDiscount={noop} />,
      { me: deviceMe({ "pos.courtesies": true, "pos.discounts": true }) },
    )

    expect(screen.getByRole("button", { name: /limonada de coco: acciones/i })).toBeInTheDocument()
    for (const name of [/^anular/i, /cortesía/i, /descuento/i, /sumar una unidad/i]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument()
    }
  })

  it("para un operador, Cortesía y Descuento quedan detrás de «Más» en el panel de la línea", async () => {
    const onCourtesy = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <OrderItemsList items={[buildOrderItem()]} onIncrement={noop} onDecrement={noop} onVoid={noop} onCourtesy={onCourtesy} onDiscount={noop} />,
      { me: deviceMe({ "pos.courtesies": true, "pos.discounts": true }) },
    )

    await user.click(screen.getByRole("button", { name: /limonada de coco: acciones/i }))
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByRole("button", { name: /^anular limonada de coco$/i })).toBeInTheDocument()
    expect(within(sheet).queryByRole("button", { name: /cortesía/i })).not.toBeInTheDocument()

    await user.click(within(sheet).getByRole("button", { name: /^más$/i }))
    expect(within(sheet).getByRole("button", { name: /descuento de limonada de coco/i })).toBeInTheDocument()
    await user.click(within(sheet).getByRole("button", { name: /cortesía de limonada de coco/i }))
    expect(onCourtesy).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }))
  })

  it("para un supervisor, Cortesía y Descuento están a la vista en el panel, sin «Más»", async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <OrderItemsList items={[buildOrderItem()]} onIncrement={noop} onDecrement={noop} onVoid={noop} onCourtesy={noop} onDiscount={noop} />,
      {
        me: deviceMe(
          { "pos.courtesies": true, "pos.discounts": true },
          { employee: { id: 5, name: "Sara", role: "supervisor", can_charge: true } },
        ),
      },
    )

    await user.click(screen.getByRole("button", { name: /limonada de coco: acciones/i }))
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByRole("button", { name: /cortesía de limonada de coco/i })).toBeInTheDocument()
    expect(within(sheet).getByRole("button", { name: /descuento de limonada de coco/i })).toBeInTheDocument()
    expect(within(sheet).queryByRole("button", { name: /^más$/i })).not.toBeInTheDocument()
  })

  it("la cantidad sólo es editable en pending; un ítem enviado la muestra como texto", async () => {
    const onIncrement = vi.fn()
    const user = userEvent.setup()
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

    // La cantidad del enviado queda como texto («1×») en su línea.
    const sentLine = screen.getByText("Sopa").closest("li") as HTMLElement
    expect(within(sentLine).getByText("1×")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /limonada de coco: acciones/i }))
    const pendingSheet = await screen.findByRole("dialog")
    await user.click(within(pendingSheet).getByRole("button", { name: /sumar una unidad de limonada de coco/i }))
    expect(onIncrement).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }))
    await user.click(within(pendingSheet).getByRole("button", { name: /^cerrar$/i }))

    await user.click(screen.getByRole("button", { name: /sopa: acciones/i }))
    const sentSheet = await screen.findByRole("dialog", { name: /sopa/i })
    expect(within(sentSheet).queryByRole("button", { name: /restar una unidad de sopa/i })).not.toBeInTheDocument()
    expect(within(sentSheet).queryByRole("button", { name: /sumar una unidad de sopa/i })).not.toBeInTheDocument()
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

    // Ni siquiera se puede abrir su panel: no le queda ninguna acción.
    expect(screen.queryByRole("button", { name: /acciones/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^anular/i })).not.toBeInTheDocument()
    expect(screen.getByText(/se fue sin pagar/i)).toBeInTheDocument()
  })

  // Motivo del cambio: el handoff (`PosComanda`) agrupa el pedido en «Sin
  // enviar · N» (lo que todavía cambia) y «Ya en cocina», y el curso viaja en
  // la etiqueta de cada línea («A2 · Fuerte») en vez de un rótulo de grupo.
  // Lo que se prueba es lo mismo: lo enviado y lo sin enviar no se mezclan, y
  // el monto es el `net` del servidor.
  it("separa lo ya en cocina de lo sin enviar, con asiento y curso en la línea", () => {
    renderWithProviders(
      <OrderItemsList
        items={[
          buildOrderItem({ id: 1, name: "Sopa de guineo", course: "starter", status: "sent", round_no: 1 }),
          buildOrderItem({ id: 2, name: "Bandeja paisa", course: "main", seat: 2, qty: 2, net: 76000 }),
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

    const sent = screen.getByRole("region", { name: "Ya en cocina" })
    expect(within(sent).getByText("Sopa de guineo")).toBeInTheDocument()
    expect(within(sent).getByText("En preparación")).toBeInTheDocument()
    expect(within(sent).queryByText("Bandeja paisa")).not.toBeInTheDocument()

    // N es la suma de unidades sin enviar (2 + 3), no de plata.
    const unsent = screen.getByRole("region", { name: "Sin enviar · 5" })
    expect(within(unsent).queryByText("Sopa de guineo")).not.toBeInTheDocument()
    const bandeja = within(unsent).getByText("Bandeja paisa").closest("li") as HTMLElement
    expect(within(bandeja).getByText("2×")).toBeInTheDocument()
    expect(within(bandeja).getByText("A2 · Fuerte")).toBeInTheDocument()
    // El monto de la línea es el `net` del backend, tal cual.
    expect(within(bandeja).getByText(/76\.000/)).toBeInTheDocument()
  })

  it("la línea elegida muestra las notas rápidas en 56 px y tocar una la pone o la saca", async () => {
    const onToggleNote = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <OrderItemsList
        items={[buildOrderItem({ id: 2, name: "Bandeja paisa", course: "main", note: "Sin cebolla" })]}
        selectedItemId={2}
        onSelect={noop}
        onToggleNote={onToggleNote}
        onIncrement={noop}
        onDecrement={noop}
        onVoid={noop}
        onCourtesy={noop}
        onDiscount={noop}
      />,
      { me: deviceMe({}) },
    )

    const notas = screen.getByRole("group", { name: "Notas rápidas de Bandeja paisa" })
    const sinCebolla = within(notas).getByRole("button", { name: "Sin cebolla" })
    expect(sinCebolla).toHaveAttribute("aria-pressed", "true")
    expect(sinCebolla.className).toMatch(/h-\[56px\]/)
    await user.click(within(notas).getByRole("button", { name: "Aparte" }))
    expect(onToggleNote).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), "Aparte")
    // La nota se lee como en el tiquete de cocina.
    expect(screen.getByText("Sin cebolla", { selector: ".tiquete-modificadores" })).toBeInTheDocument()
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
    // Motivo del cambio: la nota va en el amarillo del tiquete de cocina
    // (handoff `PosComanda`), sin el prefijo «Nota:».
    expect(within(pechuga).getByText("bien asada")).toBeInTheDocument()
    const combo = screen.getByText("Menú ejecutivo").closest("li") as HTMLElement
    expect(within(combo).getByText("Pollo")).toBeInTheDocument()
    // En línea: ningún diálogo aparte para leerlos.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})

describe("OrderItemsList · cargo de domicilio", () => {
  it("rotula el cargo como «No va a cocina»", () => {
    renderWithProviders(
      <OrderItemsList
        items={[buildOrderItem({ id: 9, name: "Domicilio", station: null, course: "main", is_delivery_fee: true })]}
        onIncrement={noop}
        onDecrement={noop}
        onVoid={noop}
        onCourtesy={noop}
        onDiscount={noop}
      />,
      { me: deviceMe({}) },
    )

    const line = screen.getByText("Domicilio").closest("li") as HTMLElement
    expect(within(line).getByText("No va a cocina")).toBeInTheDocument()
  })
})
