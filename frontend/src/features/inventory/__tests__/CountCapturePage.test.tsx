import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import type { CountDetailOut } from "@/api/inventory"
import { renderWithProviders } from "@/test/utils"

import { CountCapturePage } from "../CountCapturePage"

const { getCountMock, putCountLinesMock, postApplyCountMock, getInventoryStockMock } = vi.hoisted(() => ({
  getCountMock: vi.fn(),
  putCountLinesMock: vi.fn(),
  postApplyCountMock: vi.fn(),
  getInventoryStockMock: vi.fn(),
}))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return {
    ...actual,
    getCount: getCountMock,
    putCountLines: putCountLinesMock,
    postApplyCount: postApplyCountMock,
    // Sentinel: si esta pantalla alguna vez llegara a llamar esto, el test
    // de "a ciegas" de abajo lo detecta.
    getInventoryStock: getInventoryStockMock,
  }
})

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}))

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom")
  return { ...actual, useParams: () => ({ countId: "12" }) }
})

const BASE_COUNT: CountDetailOut = {
  id: 12,
  scope: "key_items",
  status: "open",
  opened_at: "2026-09-15T13:07:00Z",
  business_date: "2026-09-15",
  opened_by_employee_id: 3,
  opened_by_employee_name: "Ana",
  applied_at: null,
  applied_by_employee_id: null,
  applied_by_employee_name: null,
  lines_total: 2,
  lines_counted: 0,
  lines: [
    {
      ingredient_id: 1,
      ingredient_name: "Pechuga de pollo",
      base_unit: "g",
      qty_counted: null,
      was_counted: false,
      previous_qty_counted: "12500",
    },
    {
      ingredient_id: 2,
      ingredient_name: "Ron blanco",
      base_unit: "unit",
      qty_counted: null,
      was_counted: false,
      previous_qty_counted: null,
    },
  ],
}

describe("CountCapturePage — a ciegas, sin «todo coincide» (SPEC-NEGOCIO §5.4)", () => {
  it("A CIEGAS: nunca llama a getInventoryStock ni muestra ningún valor teórico, sólo el conteo anterior", async () => {
    getCountMock.mockResolvedValue(BASE_COUNT)
    getInventoryStockMock.mockResolvedValue([
      { ingredient_id: 1, name: "Pechuga de pollo", base_unit: "g", qty_base: "9999.999", min_stock: "1", below_min: false, negative: false, negative_since: null, cost: null, cost_source: "none", key_item: true },
    ])

    renderWithProviders(<CountCapturePage />, { route: "/admin/inventario/conteos/12" })

    await waitFor(() => expect(screen.getByText("Pechuga de pollo")).toBeInTheDocument())

    // La referencia en pantalla es el conteo ANTERIOR, nunca el teórico.
    expect(screen.getByText(/12500\s*g/)).toBeInTheDocument()
    expect(screen.getByText("Sin conteo anterior")).toBeInTheDocument()

    // El valor teórico centinela nunca aparece, por ningún camino.
    expect(screen.queryByText(/9999\.999/)).not.toBeInTheDocument()
    // Y la función que trae stock teórico nunca se llama desde esta pantalla.
    expect(getInventoryStockMock).not.toHaveBeenCalled()
  })

  it("NO EXISTE «todo coincide»: no hay checkbox de encabezado ni botón que confirme todo de una vez", async () => {
    getCountMock.mockResolvedValue(BASE_COUNT)
    renderWithProviders(<CountCapturePage />, { route: "/admin/inventario/conteos/12" })

    await waitFor(() => expect(screen.getByText("Pechuga de pollo")).toBeInTheDocument())

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /todo coincide/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /marcar todos/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /confirmar todos/i })).not.toBeInTheDocument()

    // Un botón "Confirmar" POR RENGLÓN — ni más, ni uno solo que los cubra todos.
    const confirmButtons = screen.getAllByRole("button", { name: "Confirmar" })
    expect(confirmButtons).toHaveLength(BASE_COUNT.lines.length)
  })

  it("confirmar un renglón manda SÓLO esa línea, con was_counted: true", async () => {
    getCountMock.mockResolvedValue(BASE_COUNT)
    putCountLinesMock.mockResolvedValue({
      lines: [
        { ...BASE_COUNT.lines[0]!, qty_counted: "12000", was_counted: true },
        BASE_COUNT.lines[1]!,
      ],
      lines_counted: 1,
      lines_total: 2,
      partial: true,
    })

    const user = userEvent.setup()
    renderWithProviders(<CountCapturePage />, { route: "/admin/inventario/conteos/12" })

    await waitFor(() => expect(screen.getByText("Pechuga de pollo")).toBeInTheDocument())

    const pollo = screen.getByLabelText("Cantidad contada — Pechuga de pollo")
    await user.type(pollo, "12000")

    const rows = screen.getAllByRole("row")
    const polloRow = within(rows.find((r) => r.textContent?.includes("Pechuga de pollo"))!)
    await user.click(polloRow.getByRole("button", { name: "Confirmar" }))

    await waitFor(() => expect(putCountLinesMock).toHaveBeenCalledTimes(1))
    expect(putCountLinesMock).toHaveBeenCalledWith(12, 1, {
      lines: [{ ingredient_id: 1, qty_counted: "12000", was_counted: true }],
    })
  })

  it("guardado parcial: el banner dice cuántos renglones faltan, siempre visible mientras falten", async () => {
    getCountMock.mockResolvedValue({ ...BASE_COUNT, lines_counted: 1, lines_total: 2 })
    renderWithProviders(<CountCapturePage />, { route: "/admin/inventario/conteos/12" })

    await waitFor(() => expect(screen.getByText(/Guardado parcial/)).toBeInTheDocument())
    expect(screen.getByText(/1 de 2 renglones confirmados/)).toBeInTheDocument()
  })

  it("sin renglones faltantes, dice que todos están confirmados (no un guardado parcial)", async () => {
    getCountMock.mockResolvedValue({ ...BASE_COUNT, lines_counted: 2, lines_total: 2 })
    renderWithProviders(<CountCapturePage />, { route: "/admin/inventario/conteos/12" })

    await waitFor(() => expect(screen.getByText(/Todos los renglones/)).toBeInTheDocument())
    expect(screen.queryByText(/Guardado parcial/)).not.toBeInTheDocument()
  })

  it("un borrador local NUNCA pisa un valor confirmado: «Guardar avance» manda was_counted: false, y si el servidor lo ignoró la pantalla vuelve a mostrar el valor confirmado, no el borrador", async () => {
    // La pechuga YA está confirmada en el servidor con "12500".
    const confirmed: CountDetailOut = {
      ...BASE_COUNT,
      lines_counted: 1,
      lines: [
        { ...BASE_COUNT.lines[0]!, qty_counted: "12500", was_counted: true },
        BASE_COUNT.lines[1]!,
      ],
    }
    getCountMock.mockResolvedValue(confirmed)
    // El servidor IGNORA el borrador (was_counted:false entrante no pisa un
    // renglón ya confirmado) y devuelve la línea intacta.
    putCountLinesMock.mockResolvedValue({ lines: confirmed.lines, lines_counted: 1, lines_total: 2, partial: true })

    const user = userEvent.setup()
    renderWithProviders(<CountCapturePage />, { route: "/admin/inventario/conteos/12" })

    await waitFor(() => expect(screen.getByText("Pechuga de pollo")).toBeInTheDocument())

    const pollo = screen.getByLabelText("Cantidad contada — Pechuga de pollo") as HTMLInputElement
    expect(pollo.value).toBe("12500")

    // Alguien escribe un borrador distinto (todavía no lo confirma).
    await user.clear(pollo)
    await user.type(pollo, "999")
    expect(pollo.value).toBe("999")

    await user.click(screen.getByRole("button", { name: "Guardar avance (sin confirmar)" }))

    await waitFor(() => expect(putCountLinesMock).toHaveBeenCalledTimes(1))
    expect(putCountLinesMock).toHaveBeenCalledWith(
      12,
      1,
      expect.objectContaining({ lines: expect.arrayContaining([{ ingredient_id: 1, qty_counted: "999", was_counted: false }]) }),
    )

    // El servidor lo ignoró (línea sigue en 12500/confirmada) — la pantalla
    // tiene que mostrar el valor CONFIRMADO, no el "999" que se tipeó.
    await waitFor(() => expect((screen.getByLabelText("Cantidad contada — Pechuga de pollo") as HTMLInputElement).value).toBe("12500"))
    expect(screen.queryByDisplayValue("999")).not.toBeInTheDocument()
  })

  it("una cantidad inválida se marca y NO se manda al confirmar", async () => {
    getCountMock.mockResolvedValue(BASE_COUNT)
    const user = userEvent.setup()
    renderWithProviders(<CountCapturePage />, { route: "/admin/inventario/conteos/12" })

    await waitFor(() => expect(screen.getByText("Pechuga de pollo")).toBeInTheDocument())

    const pollo = screen.getByLabelText("Cantidad contada — Pechuga de pollo")
    await user.type(pollo, "12kg")

    expect(pollo).toHaveAttribute("aria-invalid", "true")
    const rows = screen.getAllByRole("row")
    const polloRow = within(rows.find((r) => r.textContent?.includes("Pechuga de pollo"))!)
    expect(polloRow.getByRole("button", { name: "Confirmar" })).toBeDisabled()
    expect(putCountLinesMock).not.toHaveBeenCalled()
  })

  it("resuelve la suma «6+8» antes de confirmar", async () => {
    getCountMock.mockResolvedValue(BASE_COUNT)
    putCountLinesMock.mockResolvedValue({ lines: BASE_COUNT.lines, lines_counted: 1, lines_total: 2, partial: true })

    const user = userEvent.setup()
    renderWithProviders(<CountCapturePage />, { route: "/admin/inventario/conteos/12" })

    await waitFor(() => expect(screen.getByText("Ron blanco")).toBeInTheDocument())

    const ron = screen.getByLabelText("Cantidad contada — Ron blanco")
    await user.type(ron, "6+8")

    const rows = screen.getAllByRole("row")
    const ronRow = within(rows.find((r) => r.textContent?.includes("Ron blanco"))!)
    await user.click(ronRow.getByRole("button", { name: "Confirmar" }))

    await waitFor(() =>
      expect(putCountLinesMock).toHaveBeenCalledWith(12, 1, { lines: [{ ingredient_id: 2, qty_counted: "14", was_counted: true }] }),
    )
  })

  it("aplicar es irreversible, pide PIN, y ante 409 COUNT_ALREADY_APPLIED explica sin ofrecer reintentar", async () => {
    getCountMock.mockResolvedValue(BASE_COUNT)
    postApplyCountMock.mockRejectedValueOnce(new ApiError(409, "COUNT_ALREADY_APPLIED", "Este conteo ya se aplicó"))

    const user = userEvent.setup()
    renderWithProviders(<CountCapturePage />, { route: "/admin/inventario/conteos/12" })

    await waitFor(() => expect(screen.getByText("Pechuga de pollo")).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: "Aplicar conteo" }))
    await screen.findByRole("dialog")
    expect(screen.getByText(/irreversible/i)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Dígito 1" }))
    await user.click(screen.getByRole("button", { name: "Dígito 2" }))
    await user.click(screen.getByRole("button", { name: "Dígito 3" }))
    await user.click(screen.getByRole("button", { name: "Dígito 4" }))

    await waitFor(() => expect(screen.getByText(/ya se aplicó/i)).toBeInTheDocument())
    expect(screen.getByText(/no hay nada para reintentar/i)).toBeInTheDocument()
    // Sin PIN pad después del 409: no se ofrece un segundo intento.
    expect(screen.queryByRole("group", { name: /PIN de administrador/i })).not.toBeInTheDocument()
  })

  it("aplicar con éxito muestra el resumen antes/ajuste/después por insumo", async () => {
    getCountMock.mockResolvedValue(BASE_COUNT)
    postApplyCountMock.mockResolvedValue({
      id: 12,
      applied_at: "2026-09-15T15:42:00Z",
      applied_by_employee_id: 1,
      applied_by_employee_name: "Carlos",
      lines: [
        { ingredient_id: 1, ingredient_name: "Pechuga de pollo", qty_counted: "12000", stock_before: "12500", adjustment: "-500", stock_after: "12000" },
      ],
    })

    const user = userEvent.setup()
    renderWithProviders(<CountCapturePage />, { route: "/admin/inventario/conteos/12" })

    await waitFor(() => expect(screen.getByText("Pechuga de pollo")).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: "Aplicar conteo" }))
    await screen.findByRole("dialog")
    await user.click(screen.getByRole("button", { name: "Dígito 1" }))
    await user.click(screen.getByRole("button", { name: "Dígito 2" }))
    await user.click(screen.getByRole("button", { name: "Dígito 3" }))
    await user.click(screen.getByRole("button", { name: "Dígito 4" }))

    await waitFor(() => expect(screen.getByText("Ajuste aplicado")).toBeInTheDocument())
    expect(screen.getByText("-500")).toBeInTheDocument()
  })
})
