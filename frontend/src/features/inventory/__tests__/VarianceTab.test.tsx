import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { CountOut, VarianceOut, VarianceRowOut } from "@/api/inventory"
import { renderWithProviders } from "@/test/utils"

import { VarianceTab } from "../VarianceTab"

const { listCountsMock, getVarianceMock } = vi.hoisted(() => ({
  listCountsMock: vi.fn(),
  getVarianceMock: vi.fn(),
}))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, listCounts: listCountsMock, getVariance: getVarianceMock }
})

const APPLIED: CountOut = {
  id: 20,
  scope: "full",
  status: "applied",
  opened_at: "2026-09-14T09:00:00Z",
  business_date: "2026-09-14",
  opened_by_employee_id: 1,
  opened_by_employee_name: "Ana",
  applied_at: "2026-09-14T10:00:00Z",
  applied_by_employee_id: 1,
  applied_by_employee_name: "Ana",
  lines_total: 5,
  lines_counted: 5,
}

const OPEN: CountOut = { ...APPLIED, id: 21, status: "open", applied_at: null, applied_by_employee_id: null, applied_by_employee_name: null }

function row(overrides: Partial<VarianceRowOut>): VarianceRowOut {
  return {
    ingredient_id: 1,
    ingredient_name: "Pechuga de pollo",
    base_unit: "g",
    opening_qty: "12500",
    inflow_qty: "0",
    closing_qty: "10000",
    real_usage_qty: "2500",
    theoretical_usage_qty: "2000",
    variance_qty: "500",
    variance_value: 7500,
    cost_source: "weighted_average",
    variance_pct_bp: 2500,
    level: "red",
    ...overrides,
  }
}

function variance(overrides: Partial<VarianceOut>): VarianceOut {
  return {
    count_id: 20,
    opening_count_id: 19,
    window_from: "2026-09-07T14:00:00Z",
    window_to: "2026-09-14T14:00:00Z",
    available: true,
    reason: null,
    rows: [],
    yellow_threshold_bp: 200,
    red_threshold_bp: 400,
    latest_applied_count_id: 20,
    pareto: [],
    total_abs_variance_value: null,
    shortage_value: null,
    surplus_value: null,
    net_variance_value: null,
    unvalued_rows: 0,
    ...overrides,
  }
}

describe("VarianceTab — el semáforo lo calcula el servidor, nunca un umbral del cliente (SPEC-NEGOCIO §5.4)", () => {
  it("sólo ofrece conteos APLICADOS en el selector, nunca uno abierto", async () => {
    listCountsMock.mockResolvedValue([APPLIED, OPEN])
    getVarianceMock.mockResolvedValue(variance({}))
    const user = userEvent.setup()
    renderWithProviders(<VarianceTab storeId={1} />)

    await waitFor(() => expect(listCountsMock).toHaveBeenCalled())
    await user.click(screen.getByRole("combobox", { name: "Conteo aplicado" }))

    // El popup vive en un portal: con casi cien entornos jsdom compitiendo
    // por CPU no está montado cuando un `getAllByRole` síncrono pregunta.
    // Se espera una opción concreta primero.
    await screen.findByRole("option", { name: /#20/ })
    const options = screen.getAllByRole("option").map((o) => o.textContent)
    expect(options.some((t) => t?.includes("#20"))).toBe(true)
    expect(options.some((t) => t?.includes("#21"))).toBe(false)
  })

  it("abre sola con el último conteo aplicado: pide la varianza sin `countId` y el selector muestra el que usó el servidor (analista #12)", async () => {
    listCountsMock.mockResolvedValue([APPLIED, { ...APPLIED, id: 18, business_date: "2026-09-07" }])
    getVarianceMock.mockResolvedValue(variance({ rows: [row({})] }))

    renderWithProviders(<VarianceTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("Pechuga de pollo")).toBeInTheDocument())
    expect(getVarianceMock).toHaveBeenCalledWith({ storeId: 1, countId: null })
    expect(screen.queryByText("Elegí un conteo aplicado")).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Conteo aplicado" })).toHaveTextContent(/#20/),
    )
  })

  it("dos filas con el MISMO variance_pct_bp pero distinto `level` (servidor) pintan colores distintos — la pantalla nunca recalcula el semáforo", async () => {
    listCountsMock.mockResolvedValue([APPLIED])
    getVarianceMock.mockResolvedValue(
      variance({
        rows: [
          row({ ingredient_id: 1, ingredient_name: "Pechuga de pollo", variance_pct_bp: 250, level: "green" }),
          row({ ingredient_id: 2, ingredient_name: "Papa criolla", variance_pct_bp: 250, level: "red" }),
        ],
      }),
    )

    renderWithProviders(<VarianceTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("Pechuga de pollo")).toBeInTheDocument())

    const rows = screen.getAllByRole("row")
    const polloRow = within(rows.find((r) => r.textContent?.includes("Pechuga de pollo"))!)
    const papaRow = within(rows.find((r) => r.textContent?.includes("Papa criolla"))!)

    expect(polloRow.getByText("Verde")).toBeInTheDocument()
    expect(papaRow.getByText("Rojo")).toBeInTheDocument()
    // Los dos muestran el mismo 2,5 % — sólo el color (level) cambia, y viene del servidor.
    expect(polloRow.getByText(/^2,5\s%$/)).toBeInTheDocument()
    expect(papaRow.getByText(/^2,5\s%$/)).toBeInTheDocument()
  })

  it("las cantidades van en es-CO con su unidad: «12.500 g», no «12500 g»", async () => {
    listCountsMock.mockResolvedValue([APPLIED])
    getVarianceMock.mockResolvedValue(variance({ rows: [row({ theoretical_usage_qty: "1894.12" })] }))

    renderWithProviders(<VarianceTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("12.500 g")).toBeInTheDocument())
    expect(screen.getByText("1.894,12 g")).toBeInTheDocument()
    expect(screen.queryByText("12500 g")).not.toBeInTheDocument()
  })

  it("Pareto: titular con el total y cuántos insumos explican el 80 %, faltante ▼ y sobrante ▲, y los sin costo dichos", async () => {
    listCountsMock.mockResolvedValue([APPLIED])
    getVarianceMock.mockResolvedValue(
      variance({
        rows: [row({})],
        pareto: [
          { ingredient_id: 11, ingredient_name: "Gaseosa", variance_value: -167500, abs_value: 167500, direction: "surplus", share_bp: 5060, cumulative_bp: 5060, level: "yellow" },
          { ingredient_id: 9, ingredient_name: "Limón", variance_value: -67416, abs_value: 67416, direction: "surplus", share_bp: 2036, cumulative_bp: 7096, level: "yellow" },
          { ingredient_id: 1, ingredient_name: "Pechuga", variance_value: 96142, abs_value: 96142, direction: "shortage", share_bp: 2904, cumulative_bp: 10000, level: "red" },
        ],
        total_abs_variance_value: 331058,
        shortage_value: 96142,
        surplus_value: -234916,
        net_variance_value: -138774,
        unvalued_rows: 2,
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<VarianceTab storeId={1} />)

    expect(
      await screen.findByRole("heading", {
        name: "$ 331.058 de varianza entre faltantes y sobrantes: 3 insumos explican el 80 %",
      }),
    ).toBeInTheDocument()
    expect(screen.getByText(/\$ 96\.142 de faltante y \$ 234\.916 de sobrante · 2 insumos sin costo, no entran/)).toBeInTheDocument()
    // La tabla gemela: dirección con flecha y palabra; el sobrante nunca en rojo.
    await user.click(screen.getByRole("button", { name: "Ver tabla" }))
    const gemela = screen.getAllByRole("table").find((t) => t.textContent?.includes("Acumulado"))!
    const sobrantes = within(gemela).getAllByText(/sobrante$/)
    expect(sobrantes).toHaveLength(2)
    for (const s of sobrantes) {
      expect(s.className).not.toMatch(/destructive/)
      expect(s.className).toMatch(/warning/)
      expect(s.textContent).toMatch(/▲/)
    }
    const pechuga = within(gemela).getByText(/faltante$/)
    expect(pechuga.className).toMatch(/destructive/)
    expect(pechuga.textContent).toMatch(/▼/)
    expect(within(gemela).getByText(/^100,0\s%$/)).toBeInTheDocument()
  })

  it("sin conteo anterior aplicado contra el cual comparar: `available=false` explica el motivo, nunca una tabla vacía muda", async () => {
    listCountsMock.mockResolvedValue([APPLIED])
    getVarianceMock.mockResolvedValue(
      variance({
        opening_count_id: null,
        window_from: null,
        available: false,
        reason: "No hay un conteo anterior aplicado contra el cual comparar",
      }),
    )

    renderWithProviders(<VarianceTab storeId={1} />)

    await waitFor(() => expect(screen.getByText(/No hay un conteo anterior aplicado/)).toBeInTheDocument())
  })

  it("un insumo sin costo dice «Sin costo», nunca $0", async () => {
    listCountsMock.mockResolvedValue([APPLIED])
    getVarianceMock.mockResolvedValue(variance({ rows: [row({ variance_value: null, cost_source: "none" })] }))

    renderWithProviders(<VarianceTab storeId={1} />)

    await waitFor(() => expect(within(screen.getByRole("table")).getByText("Sin costo")).toBeInTheDocument())
    // La leyenda del pie dice, con esas palabras, «no es $ 0»: la afirmación
    // es que la CELDA no lo diga.
    expect(within(screen.getByRole("table")).queryByText("$ 0")).not.toBeInTheDocument()
  })
})
