/**
 * «Conteo de mi área» en el POS. Lo que no se negocia:
 *
 * - con la función apagada no consulta y dice qué la prende;
 * - muestra sólo lo que manda el servidor (la lista del área), sin stock ni
 *   conteo anterior;
 * - la entrada es cómoda por unidad y lo que viaja es el texto tal cual
 *   («2.3» = 2 botellas y 3/10): la pantalla no convierte ni calcula;
 * - no se puede guardar hasta contar todos los artículos, y antes de
 *   guardar se revisa un resumen de lo tecleado (sin nada esperado);
 * - las décimas de la abierta arrancan sin marcar: olvidarlas no es «0»;
 * - un campo de enteros con coma avisa en vez de pegar los dígitos
 *   («5,5» nunca se vuelve 55); el rótulo usa la unidad de compra;
 * - el momento arranca en el que sugiere el servidor;
 * - los recuentos pedidos van arriba y se responden aparte.
 */
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DeviceAreaCountBoardOut } from "@/api/areaCounts"
import { buildMe, renderWithProviders } from "@/test/utils"

import { AreaCountPanel } from "../AreaCountPanel"

const mocks = vi.hoisted(() => ({
  getDeviceAreaCount: vi.fn(),
  postAreaCount: vi.fn(),
  answerAreaRecount: vi.fn(),
}))

vi.mock("@/api/areaCounts", async () => {
  const actual = await vi.importActual<typeof import("@/api/areaCounts")>("@/api/areaCounts")
  return { ...actual, ...mocks }
})

function board(overrides: Partial<DeviceAreaCountBoardOut> = {}): DeviceAreaCountBoardOut {
  return {
    area_id: 1,
    area_name: "Bar",
    reason: null,
    business_date: "2026-09-25",
    items: [
      { ingredient_id: 10, name: "Ron", base_unit: "ml", entry_mode: "bottle", entry_unit: "botella" },
      { ingredient_id: 11, name: "Limón", base_unit: "g", entry_mode: "weight", entry_unit: "kg" },
    ],
    suggested_moment: "closing",
    opening_done: { count_id: 5, counted_at: "2026-09-25T14:00:00Z", employee_name: "Ana" },
    closing_done: null,
    recounts: [],
    ...overrides,
  }
}

function me(on = true) {
  return buildMe({ kind: "device", features: { "inventory.shift_counts": on } })
}

describe("AreaCountPanel", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset()
  })

  it("con la función apagada no consulta y dice qué la prende", () => {
    renderWithProviders(<AreaCountPanel />, { me: me(false) })
    expect(screen.getByText(/no está habilitado/i)).toBeInTheDocument()
    expect(mocks.getDeviceAreaCount).not.toHaveBeenCalled()
  })

  it("sin área asignada dice el motivo del servidor", async () => {
    mocks.getDeviceAreaCount.mockResolvedValue(
      board({ area_id: null, area_name: null, items: [], reason: "No tenés un área de conteo asignada." }),
    )
    renderWithProviders(<AreaCountPanel />, { me: me() })
    expect(await screen.findByText("No tenés un área de conteo asignada.")).toBeInTheDocument()
  })

  it("cuenta a ciegas, con el momento sugerido, y manda el texto tal cual", async () => {
    const user = userEvent.setup()
    mocks.getDeviceAreaCount.mockResolvedValue(board())
    mocks.postAreaCount.mockResolvedValue({
      id: 9, area_name: "Bar", moment: "closing", counted_at: "2026-09-26T03:00:00Z", employee_name: "Beto", lines_count: 2,
    })
    renderWithProviders(<AreaCountPanel />, { me: me() })

    expect(await screen.findByRole("heading", { name: "Conteo de Bar" })).toBeInTheDocument()
    // El momento sugerido por el servidor viene marcado.
    expect(screen.getByRole("button", { name: "Cierre" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByText(/Contó Ana/)).toBeInTheDocument()
    // Ni stock ni conteo anterior en pantalla.
    expect(screen.queryByText(/stock|esperado|sistema/i)).not.toBeInTheDocument()

    const revisar = screen.getByRole("button", { name: "Revisar conteo" })
    expect(revisar).toBeDisabled()
    expect(screen.queryByRole("button", { name: /Guardar conteo/ })).not.toBeInTheDocument()

    await user.type(screen.getByLabelText("Botellas enteras"), "2")
    await user.click(screen.getByRole("button", { name: "3/10 de Ron" }))
    expect(revisar).toBeDisabled() // falta el limón
    await user.type(screen.getByLabelText("Limón"), "1,5")
    expect(revisar).toBeEnabled()
    await user.click(revisar)

    // El resumen repite lo tecleado, con su unidad, y nada esperado.
    expect(screen.getByText("2,3 botellas")).toBeInTheDocument()
    expect(screen.getByText("1,5 kg")).toBeInTheDocument()
    expect(screen.queryByText(/stock|esperado|sistema/i)).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Guardar conteo de cierre/ }))

    await waitFor(() => expect(mocks.postAreaCount).toHaveBeenCalled())
    const [body, key] = mocks.postAreaCount.mock.calls[0]!
    expect(body).toEqual({
      moment: "closing",
      lines: [
        { ingredient_id: 10, qty: "2.3" },
        { ingredient_id: 11, qty: "1,5" },
      ],
    })
    expect(typeof key).toBe("string")
    expect(await screen.findByText(/Cierre de Bar: contó Beto/)).toBeInTheDocument()
  })

  it("se puede cambiar el momento sugerido", async () => {
    const user = userEvent.setup()
    mocks.getDeviceAreaCount.mockResolvedValue(board({ suggested_moment: "opening", opening_done: null }))
    renderWithProviders(<AreaCountPanel />, { me: me() })
    await user.click(await screen.findByRole("button", { name: "Cierre" }))
    expect(screen.getByRole("button", { name: "Cierre" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByText(/Al cerrar cuenta quien sale/)).toBeInTheDocument()
  })

  it("los recuentos pedidos van arriba y se responden aparte", async () => {
    const user = userEvent.setup()
    mocks.getDeviceAreaCount.mockResolvedValue(
      board({
        recounts: [
          {
            id: 7,
            requested_at: "2026-09-25T18:00:00Z",
            requested_by_employee_name: "Admin",
            note: "Revisá el ron",
            items: [{ ingredient_id: 10, name: "Ron", base_unit: "ml", entry_mode: "bottle", entry_unit: "botella" }],
          },
        ],
      }),
    )
    mocks.answerAreaRecount.mockResolvedValue({
      id: 12, area_name: "Bar", moment: "spot", counted_at: "2026-09-25T18:10:00Z", employee_name: "Beto", lines_count: 1,
    })
    renderWithProviders(<AreaCountPanel />, { me: me() })

    const seccion = (await screen.findByRole("heading", { name: "Recuentos pedidos (1)" })).closest("section") as HTMLElement
    expect(within(seccion).getByText("Revisá el ron")).toBeInTheDocument()
    await user.type(within(seccion).getByLabelText("Botellas enteras"), "4")
    const revisar = within(seccion).getByRole("button", { name: "Revisar recuento" })
    expect(revisar).toBeDisabled() // falta marcar la abierta, aunque sea 0
    await user.click(within(seccion).getByRole("button", { name: "0/10 de Ron" }))
    await user.click(revisar)
    expect(within(seccion).getByText("4 botellas")).toBeInTheDocument()
    await user.click(within(seccion).getByRole("button", { name: "Enviar recuento" }))
    await waitFor(() => expect(mocks.answerAreaRecount).toHaveBeenCalled())
    expect(mocks.answerAreaRecount.mock.calls[0]![0]).toBe(7)
    expect(mocks.answerAreaRecount.mock.calls[0]![1]).toEqual([{ ingredient_id: 10, qty: "4" }])
  })

  it("las décimas arrancan sin marcar: sin tocar una, el artículo no está contado", async () => {
    const user = userEvent.setup()
    mocks.getDeviceAreaCount.mockResolvedValue(board())
    renderWithProviders(<AreaCountPanel />, { me: me() })

    await user.type(await screen.findByLabelText("Botellas enteras"), "2")
    await user.type(screen.getByLabelText("Limón"), "1")
    for (const d of ["0", "1", "5", "9"]) {
      expect(screen.getByRole("button", { name: `${d}/10 de Ron` })).toHaveAttribute("aria-pressed", "false")
    }
    expect(screen.getByRole("button", { name: "Revisar conteo" })).toBeDisabled()
    expect(screen.getByText(/si no hay, tocá 0/)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "0/10 de Ron" }))
    expect(screen.getByRole("button", { name: "Revisar conteo" })).toBeEnabled()
  })

  it("una coma en las enteras avisa y no pega los dígitos («5,5» nunca es 55)", async () => {
    const user = userEvent.setup()
    mocks.getDeviceAreaCount.mockResolvedValue(board())
    renderWithProviders(<AreaCountPanel />, { me: me() })

    const enteras = await screen.findByLabelText("Botellas enteras")
    await user.type(enteras, "5,5")
    expect(enteras).toHaveValue("5,5")
    expect(enteras).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByRole("alert")).toHaveTextContent(/sólo botellas enteras, sin coma/)
    await user.click(screen.getByRole("button", { name: "5/10 de Ron" }))
    await user.type(screen.getByLabelText("Limón"), "1")
    expect(screen.getByRole("button", { name: "Revisar conteo" })).toBeDisabled()

    await user.clear(enteras)
    await user.type(enteras, "5")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Revisar conteo" }))
    expect(screen.getByText("5,5 botellas")).toBeInTheDocument()
  })

  it("el rótulo usa la unidad de compra, y lo que va por unidad no admite decimales", async () => {
    const user = userEvent.setup()
    mocks.getDeviceAreaCount.mockResolvedValue(
      board({
        items: [
          { ingredient_id: 20, name: "Leche", base_unit: "ml", entry_mode: "bottle", entry_unit: "bolsa" },
          { ingredient_id: 21, name: "Aceite", base_unit: "ml", entry_mode: "bottle", entry_unit: "garrafa" },
          { ingredient_id: 22, name: "Huevos", base_unit: "unit", entry_mode: "unit", entry_unit: "unidad" },
        ],
      }),
    )
    mocks.postAreaCount.mockResolvedValue({
      id: 9, area_name: "Bar", moment: "closing", counted_at: "2026-09-26T03:00:00Z", employee_name: "Beto", lines_count: 3,
    })
    renderWithProviders(<AreaCountPanel />, { me: me() })

    await user.type(await screen.findByLabelText("Bolsas enteras"), "55")
    await user.click(screen.getByRole("button", { name: "3/10 de Leche" }))
    await user.type(screen.getByLabelText("Garrafas enteras"), "2")
    await user.click(screen.getByRole("button", { name: "0/10 de Aceite" }))
    const huevos = screen.getByLabelText("Huevos")
    await user.type(huevos, "5,5")
    expect(screen.getByRole("alert")).toHaveTextContent("Se cuentan unidades enteras, sin decimales.")
    expect(screen.getByRole("button", { name: "Revisar conteo" })).toBeDisabled()
    await user.clear(huevos)
    await user.type(huevos, "30")

    await user.click(screen.getByRole("button", { name: "Revisar conteo" }))
    expect(screen.getByText("55,3 bolsas")).toBeInTheDocument()
    expect(screen.getByText("2 garrafas")).toBeInTheDocument()
    expect(screen.getByText("30 unidades")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Guardar conteo de cierre/ }))
    await waitFor(() => expect(mocks.postAreaCount).toHaveBeenCalled())
    expect(mocks.postAreaCount.mock.calls[0]![0].lines).toEqual([
      { ingredient_id: 20, qty: "55.3" },
      { ingredient_id: 21, qty: "2" },
      { ingredient_id: 22, qty: "30" },
    ])
  })
})
