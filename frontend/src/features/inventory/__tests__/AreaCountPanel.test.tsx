/**
 * La pantalla de conteo por área del POS (`/pos/conteo` y «Conteo» en
 * Turno). Lo que no se negocia:
 *
 * - con la función apagada no consulta y dice qué la prende;
 * - trae las listas de todas las áreas y se filtra: Mi área | cada área |
 *   Todo (quien termina primero ayuda al otro);
 * - a ciegas: ni stock, ni esperado, ni la cantidad que tecleó otro —sólo
 *   «Contado por Ana · 7:10»—;
 * - cada artículo se guarda solo, y lo que viaja es el texto tal cual
 *   («2.3» = 2 botellas y 3/10): la pantalla no convierte ni calcula;
 * - un artículo ya contado se puede recontar (manda el último);
 * - las décimas de la abierta arrancan sin marcar: olvidarlas no es «0»;
 * - un campo de enteros con coma avisa en vez de pegar los dígitos
 *   («5,5» nunca se vuelve 55); el rótulo usa la unidad de compra;
 * - el momento arranca en el que sugiere el servidor;
 * - la apertura obligatoria se dice en rojo;
 * - los recuentos pedidos van arriba y se responden aparte.
 *
 * **Movido a propósito (0030)**: antes la pantalla guardaba la lista entera
 * de una vez, detrás de «Revisar conteo» con un resumen; el dueño pidió que
 * cada artículo se guarde al contarlo, con quién y cuándo, así que el
 * resumen de revisión quedó sólo en el recuento sorpresa (que sigue siendo
 * de lista entera) y las mismas reglas de entrada se prueban por artículo.
 */
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AreaCountSheetAreaOut, DeviceAreaCountSheetOut } from "@/api/areaCounts"
import { buildMe, renderWithProviders } from "@/test/utils"

import { AreaCountPanel } from "../AreaCountPanel"

const mocks = vi.hoisted(() => ({
  getAreaCountSheet: vi.fn(),
  postAreaCountItem: vi.fn(),
  answerAreaRecount: vi.fn(),
}))

vi.mock("@/api/areaCounts", async () => {
  const actual = await vi.importActual<typeof import("@/api/areaCounts")>("@/api/areaCounts")
  return { ...actual, ...mocks }
})

const SIN = { counted: 0, total: 2, complete: false, completed_at: null, people: [] }

function bar(overrides: Partial<AreaCountSheetAreaOut> = {}): AreaCountSheetAreaOut {
  return {
    area_id: 1,
    area_name: "Bar",
    scope: "short",
    mine: true,
    items: [
      {
        ingredient_id: 10, name: "Ron", base_unit: "ml", entry_mode: "bottle", entry_unit: "botella",
        opening: { employee_name: "Ana", counted_at: "2026-09-25T12:10:00Z", entries: 1 },
        closing: null,
      },
      { ingredient_id: 11, name: "Limón", base_unit: "g", entry_mode: "weight", entry_unit: "kg", opening: null, closing: null },
    ],
    opening: { counted: 1, total: 2, complete: false, completed_at: null, people: ["Ana"] },
    closing: SIN,
    ...overrides,
  }
}

function cocina(): AreaCountSheetAreaOut {
  return {
    area_id: 2,
    area_name: "Cocina",
    scope: "short",
    mine: false,
    items: [
      { ingredient_id: 20, name: "Carne", base_unit: "g", entry_mode: "weight", entry_unit: "kg", opening: null, closing: null },
      { ingredient_id: 21, name: "Huevos", base_unit: "unit", entry_mode: "unit", entry_unit: "unidad", opening: null, closing: null },
    ],
    opening: SIN,
    closing: SIN,
  }
}

function sheet(overrides: Partial<DeviceAreaCountSheetOut> = {}): DeviceAreaCountSheetOut {
  return {
    business_date: "2026-09-25",
    my_area_id: 1,
    reason: null,
    suggested_moment: "opening",
    full_count_today: false,
    opening_required: true,
    areas: [bar(), cocina()],
    recounts: [],
    ...overrides,
  }
}

function saved(ingredient_id: number, name: string) {
  return {
    area_id: 1, area_name: "Bar", moment: "opening", ingredient_id, ingredient_name: name, count_id: 9,
    counted_at: "2026-09-25T12:20:00Z", employee_name: "Beto",
    progress: { counted: 2, total: 2, complete: true, completed_at: "2026-09-25T12:20:00Z", people: ["Ana", "Beto"] },
  }
}

function me(on = true) {
  return buildMe({ kind: "device", features: { "inventory.shift_counts": on } })
}

function fila(nombre: string): HTMLElement {
  return screen.getByText(nombre, { selector: "label, span" }).closest("li") as HTMLElement
}

describe("AreaCountPanel", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset()
  })

  it("con la función apagada no consulta y dice qué la prende", () => {
    renderWithProviders(<AreaCountPanel />, { me: me(false) })
    expect(screen.getByText(/no está habilitado/i)).toBeInTheDocument()
    expect(mocks.getAreaCountSheet).not.toHaveBeenCalled()
  })

  it("sin área propia dice el motivo del servidor y muestra todo para ayudar", async () => {
    mocks.getAreaCountSheet.mockResolvedValue(
      sheet({
        my_area_id: null,
        opening_required: false,
        reason: "No tenés un área de conteo asignada: podés ayudar a contar cualquier área.",
        areas: [bar({ mine: false }), cocina()],
      }),
    )
    renderWithProviders(<AreaCountPanel />, { me: me() })
    expect(await screen.findByText(/podés ayudar a contar cualquier área/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Mi área/ })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Todo" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByText("Carne")).toBeInTheDocument()
    expect(screen.getByText("Ron")).toBeInTheDocument()
  })

  it("filtra Mi área | Bar | Cocina | Todo", async () => {
    const user = userEvent.setup()
    mocks.getAreaCountSheet.mockResolvedValue(sheet())
    renderWithProviders(<AreaCountPanel />, { me: me() })

    const grupo = await screen.findByRole("group", { name: "Qué lista ver" })
    expect(within(grupo).getByRole("button", { name: /Mi área/ })).toHaveAttribute("aria-pressed", "true")
    expect(within(grupo).getByRole("button", { name: /Mi área/ })).toHaveTextContent("1 de 2")
    expect(screen.getByText("Ron")).toBeInTheDocument()
    expect(screen.queryByText("Carne")).not.toBeInTheDocument()

    await user.click(within(grupo).getByRole("button", { name: /Cocina/ }))
    expect(screen.getByText("Carne")).toBeInTheDocument()
    expect(screen.queryByText("Ron")).not.toBeInTheDocument()

    await user.click(within(grupo).getByRole("button", { name: "Todo" }))
    expect(screen.getByText("Carne")).toBeInTheDocument()
    expect(screen.getByText("Ron")).toBeInTheDocument()
  })

  it("a ciegas: quién contó y cuándo, nunca cuánto; y la apertura obligatoria en rojo", async () => {
    mocks.getAreaCountSheet.mockResolvedValue(sheet())
    renderWithProviders(<AreaCountPanel />, { me: me() })

    expect(await screen.findByText("Primero el conteo de apertura de Bar")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Apertura" })).toHaveAttribute("aria-pressed", "true")
    expect(within(fila("Ron")).getByText("Contado por Ana · 7:10")).toBeInTheDocument()
    expect(within(fila("Limón")).getByText("Sin contar")).toBeInTheDocument()
    expect(screen.queryByText(/stock|esperado|sistema/i)).not.toBeInTheDocument()
    // Lo ya contado se recuenta; lo que no, se guarda.
    expect(within(fila("Ron")).getByRole("button", { name: "Recontar" })).toBeInTheDocument()
    expect(within(fila("Limón")).getByRole("button", { name: "Guardar" })).toBeInTheDocument()
  })

  it("cada artículo se guarda solo y viaja el texto tal cual", async () => {
    const user = userEvent.setup()
    mocks.getAreaCountSheet.mockResolvedValue(sheet())
    mocks.postAreaCountItem.mockResolvedValue(saved(11, "Limón"))
    renderWithProviders(<AreaCountPanel />, { me: me() })

    const limon = await screen.findByLabelText("Limón")
    const guardar = within(fila("Limón")).getByRole("button", { name: "Guardar" })
    expect(guardar).toBeDisabled()
    await user.type(limon, "1,5")
    await user.click(guardar)
    await waitFor(() => expect(mocks.postAreaCountItem).toHaveBeenCalled())
    const [body, key] = mocks.postAreaCountItem.mock.calls[0]!
    expect(body).toEqual({ area_id: 1, moment: "opening", ingredient_id: 11, qty: "1,5" })
    expect(typeof key).toBe("string")
    // Guardado, el campo se limpia: lo tecleado no queda a la vista del siguiente.
    await waitFor(() => expect(screen.getByLabelText("Limón")).toHaveValue(""))
  })

  it("se puede cambiar el momento sugerido", async () => {
    const user = userEvent.setup()
    mocks.getAreaCountSheet.mockResolvedValue(sheet())
    mocks.postAreaCountItem.mockResolvedValue(saved(11, "Limón"))
    renderWithProviders(<AreaCountPanel />, { me: me() })
    await user.click(await screen.findByRole("button", { name: "Cierre" }))
    expect(screen.getByRole("button", { name: "Cierre" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByText(/Al cerrar cuenta quien sale/)).toBeInTheDocument()
    expect(within(fila("Ron")).getByText("Sin contar")).toBeInTheDocument() // el cierre del ron no se contó
    await user.type(screen.getByLabelText("Limón"), "2")
    await user.click(within(fila("Limón")).getByRole("button", { name: "Guardar" }))
    await waitFor(() => expect(mocks.postAreaCountItem.mock.calls[0]![0].moment).toBe("closing"))
  })

  it("las décimas arrancan sin marcar: sin tocar una, la botella no está contada", async () => {
    const user = userEvent.setup()
    mocks.getAreaCountSheet.mockResolvedValue(sheet())
    mocks.postAreaCountItem.mockResolvedValue(saved(10, "Ron"))
    renderWithProviders(<AreaCountPanel />, { me: me() })

    await user.type(await screen.findByLabelText("Botellas enteras"), "2")
    for (const d of ["0", "1", "5", "9"]) {
      expect(screen.getByRole("button", { name: `${d}/10 de Ron` })).toHaveAttribute("aria-pressed", "false")
    }
    const recontar = within(fila("Ron")).getByRole("button", { name: "Recontar" })
    expect(recontar).toBeDisabled()
    expect(screen.getByText(/si no hay, tocá 0/)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "3/10 de Ron" }))
    expect(recontar).toBeEnabled()
    await user.click(recontar)
    await waitFor(() => expect(mocks.postAreaCountItem).toHaveBeenCalled())
    expect(mocks.postAreaCountItem.mock.calls[0]![0].qty).toBe("2.3")
  })

  it("una coma en las enteras avisa y no pega los dígitos («5,5» nunca es 55)", async () => {
    const user = userEvent.setup()
    mocks.getAreaCountSheet.mockResolvedValue(sheet())
    renderWithProviders(<AreaCountPanel />, { me: me() })

    const enteras = await screen.findByLabelText("Botellas enteras")
    await user.type(enteras, "5,5")
    expect(enteras).toHaveValue("5,5")
    expect(enteras).toHaveAttribute("aria-invalid", "true")
    expect(within(fila("Ron")).getByRole("alert")).toHaveTextContent(/sólo botellas enteras, sin coma/)
    await user.click(screen.getByRole("button", { name: "5/10 de Ron" }))
    expect(within(fila("Ron")).getByRole("button", { name: "Recontar" })).toBeDisabled()

    await user.clear(enteras)
    await user.type(enteras, "5")
    expect(within(fila("Ron")).queryByRole("alert")).not.toBeInTheDocument()
    expect(within(fila("Ron")).getByRole("button", { name: "Recontar" })).toBeEnabled()
  })

  it("el rótulo usa la unidad de compra, y lo que va por unidad no admite decimales", async () => {
    const user = userEvent.setup()
    mocks.getAreaCountSheet.mockResolvedValue(
      sheet({
        areas: [
          bar({
            items: [
              { ingredient_id: 30, name: "Leche", base_unit: "ml", entry_mode: "bottle", entry_unit: "bolsa", opening: null, closing: null },
              { ingredient_id: 31, name: "Aceite", base_unit: "ml", entry_mode: "bottle", entry_unit: "garrafa", opening: null, closing: null },
              { ingredient_id: 32, name: "Huevos", base_unit: "unit", entry_mode: "unit", entry_unit: "unidad", opening: null, closing: null },
            ],
          }),
        ],
      }),
    )
    mocks.postAreaCountItem.mockResolvedValue(saved(32, "Huevos"))
    renderWithProviders(<AreaCountPanel />, { me: me() })

    expect(await screen.findByLabelText("Bolsas enteras")).toBeInTheDocument()
    expect(screen.getByLabelText("Garrafas enteras")).toBeInTheDocument()
    const huevos = screen.getByLabelText("Huevos")
    await user.type(huevos, "5,5")
    expect(within(fila("Huevos")).getByRole("alert")).toHaveTextContent("Se cuentan unidades enteras, sin decimales.")
    expect(within(fila("Huevos")).getByRole("button", { name: "Guardar" })).toBeDisabled()
    await user.clear(huevos)
    await user.type(huevos, "30")
    await user.click(within(fila("Huevos")).getByRole("button", { name: "Guardar" }))
    await waitFor(() => expect(mocks.postAreaCountItem).toHaveBeenCalled())
    expect(mocks.postAreaCountItem.mock.calls[0]![0]).toMatchObject({ ingredient_id: 32, qty: "30" })
  })

  it("el día del conteo completo lo avisa, y la lista es la que manda el servidor", async () => {
    mocks.getAreaCountSheet.mockResolvedValue(sheet({ full_count_today: true, areas: [bar({ scope: "full" }), cocina()] }))
    renderWithProviders(<AreaCountPanel />, { me: me() })
    expect(await screen.findByText(/Hoy es el conteo completo del mes/)).toBeInTheDocument()
    expect(screen.getByText("conteo completo")).toBeInTheDocument()
  })

  it("los recuentos pedidos van arriba y se responden aparte", async () => {
    const user = userEvent.setup()
    mocks.getAreaCountSheet.mockResolvedValue(
      sheet({
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
})
