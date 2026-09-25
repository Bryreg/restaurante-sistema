/**
 * «Conteo de mi área» en el POS. Lo que no se negocia:
 *
 * - con la función apagada no consulta y dice qué la prende;
 * - muestra sólo lo que manda el servidor (la lista del área), sin stock ni
 *   conteo anterior;
 * - la entrada es cómoda por unidad y lo que viaja es el texto tal cual
 *   («2.3» = 2 botellas y 3/10): la pantalla no convierte ni calcula;
 * - no se puede guardar hasta contar todos los artículos;
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

    const guardar = screen.getByRole("button", { name: /Guardar conteo de cierre/ })
    expect(guardar).toBeDisabled()

    await user.type(screen.getByLabelText("Botellas enteras"), "2")
    await user.click(screen.getByRole("button", { name: "3/10 de Ron" }))
    expect(guardar).toBeDisabled() // falta el limón
    await user.type(screen.getByLabelText("Limón"), "1,5")
    expect(guardar).toBeEnabled()
    await user.click(guardar)

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
    expect(screen.getByRole("button", { name: /Guardar conteo de cierre/ })).toBeInTheDocument()
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
    await user.click(within(seccion).getByRole("button", { name: "Enviar recuento" }))
    await waitFor(() => expect(mocks.answerAreaRecount).toHaveBeenCalled())
    expect(mocks.answerAreaRecount.mock.calls[0]![0]).toBe(7)
    expect(mocks.answerAreaRecount.mock.calls[0]![1]).toEqual([{ ingredient_id: 10, qty: "4" }])
  })
})
