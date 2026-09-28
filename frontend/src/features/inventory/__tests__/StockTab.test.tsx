import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { buildMe, renderWithProviders } from "@/test/utils"

import { StockTab } from "../StockTab"

const { getInventoryStockMock } = vi.hoisted(() => ({ getInventoryStockMock: vi.fn() }))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, getInventoryStock: getInventoryStockMock }
})

describe("StockTab — «negativo» y «bajo mínimo» son alertas distintas (SPEC-NEGOCIO §5.2)", () => {
  it("un insumo negativo se ve distinto (rojo, «deuda de registro») de uno sólo bajo mínimo (ámbar, «reponé»)", async () => {
    getInventoryStockMock.mockResolvedValue([
      {
        ingredient_id: 1,
        name: "Helado de vainilla",
        base_unit: "g",
        qty_base: "-400",
        min_stock: "2000",
        below_min: true,
        negative: true,
        negative_since: "2026-06-15T00:00:00Z",
        cost: null,
        cost_source: "none",
        key_item: false,
      },
      {
        ingredient_id: 2,
        name: "Papa criolla",
        base_unit: "g",
        qty_base: "500",
        min_stock: "1000",
        below_min: true,
        negative: false,
        negative_since: null,
        cost: "3500",
        cost_source: "estimated",
        key_item: true,
      },
      {
        ingredient_id: 3,
        name: "Arroz",
        base_unit: "g",
        qty_base: "5000",
        min_stock: "1000",
        below_min: false,
        negative: false,
        negative_since: null,
        cost: "2000",
        cost_source: "official",
        key_item: false,
      },
    ])

    renderWithProviders(<StockTab storeId={1} />)

    await waitFor(() => expect(screen.getByText("Helado de vainilla")).toBeInTheDocument())

    const rows = screen.getAllByRole("row")
    const heladoRow = within(rows.find((r) => r.textContent?.includes("Helado de vainilla"))!)
    const papaRow = within(rows.find((r) => r.textContent?.includes("Papa criolla"))!)
    const arrozRow = within(rows.find((r) => r.textContent?.includes("Arroz"))!)

    // La fila dice LA PALABRA; el significado vive en la leyenda del pie, una
    // sola vez (`docs/PATRONES-ADMIN.md` § 8d) en vez de repetirse en cada
    // renglón — que era lo que hacía crecer la fila por encima de los 34 px.
    // Lo que esta prueba defiende es que las dos NO se confundan.
    expect(heladoRow.getByText("Negativo")).toBeInTheDocument()
    expect(heladoRow.queryByText(/agotado/i)).not.toBeInTheDocument()

    // Bajo mínimo (sin ser negativo): palabra DISTINTA, y sin la de negativo.
    expect(papaRow.getByText("Bajo mínimo")).toBeInTheDocument()
    expect(papaRow.queryByText("Negativo")).not.toBeInTheDocument()

    // Al día: sin ninguna de las dos alertas.
    expect(arrozRow.getByText("Al día")).toBeInTheDocument()

    // La leyenda sostiene la distinción, y la sostiene ENTERA: deuda de
    // registro (no bloquea la venta) contra reposición.
    const legend = within(screen.getByRole("table").parentElement!.parentElement!)
    expect(legend.getByText(/deuda de registro/i)).toBeInTheDocument()
    expect(legend.getByText(/no bloquea la venta/i)).toBeInTheDocument()
    expect(legend.getByText(/reposición/i)).toBeInTheDocument()

    // Costo null se dice "Sin costo", nunca $0.
    expect(heladoRow.getByText("Sin costo")).toBeInTheDocument()
    expect(within(screen.getByRole("table")).queryByText("$ 0")).not.toBeInTheDocument()
  })

  it("los filtros críticos/bajo mínimo/negativos se mandan al servidor, nunca se cruzan en el cliente", async () => {
    getInventoryStockMock.mockResolvedValue([])
    renderWithProviders(<StockTab storeId={7} initialNegative initialBelowMin />)

    await waitFor(() =>
      expect(getInventoryStockMock).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: 7, negative: true, belowMin: true, criticalOnly: false }),
      ),
    )
  })
})

// ---------------------------------------------------------------------------
// La tabla densa del handoff (pantalla 12 · `AdminTabla.dc.html`).
// ---------------------------------------------------------------------------

const FILAS_HANDOFF = [
  {
    ingredient_id: 11,
    name: "Pechuga de pollo",
    base_unit: "g",
    qty_base: "-2400",
    min_stock: "8000",
    below_min: true,
    negative: true,
    negative_since: "2026-09-26T11:00:00Z",
    cost: "18.9",
    cost_source: "official",
    key_item: true,
  },
  {
    ingredient_id: 12,
    name: "Hielo",
    base_unit: "unit",
    qty_base: "6",
    min_stock: "4",
    below_min: false,
    negative: false,
    negative_since: null,
    cost: null,
    cost_source: "none",
    key_item: false,
  },
  {
    ingredient_id: 13,
    name: "Limón tahití",
    base_unit: "g",
    qty_base: "6000",
    min_stock: "5000",
    below_min: false,
    negative: false,
    negative_since: null,
    cost: "3.8",
    cost_source: "weighted_average",
    key_item: false,
  },
]

describe("StockTab — la tabla densa del handoff", () => {
  beforeEach(() => {
    getInventoryStockMock.mockReset()
    getInventoryStockMock.mockResolvedValue(FILAS_HANDOFF)
  })

  it("los filtros son píldoras que se mandan al servidor; «Todos» los apaga", async () => {
    const user = userEvent.setup()
    renderWithProviders(<StockTab storeId={3} />)

    await screen.findByText("Hielo")
    expect(screen.getByRole("button", { name: "Todos" })).toHaveAttribute("aria-pressed", "true")
    await user.click(screen.getByRole("button", { name: "Negativos" }))
    expect(screen.getByRole("button", { name: "Negativos" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Todos" })).toHaveAttribute("aria-pressed", "false")
    await waitFor(() =>
      expect(getInventoryStockMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 3, negative: true })),
    )
    await user.click(screen.getByRole("button", { name: "Todos" }))
    expect(screen.getByRole("button", { name: "Negativos" })).toHaveAttribute("aria-pressed", "false")
  })

  it("buscar por nombre encuentra sin tildes, y el recuento dice cuántas quedaron afuera", async () => {
    const user = userEvent.setup()
    renderWithProviders(<StockTab storeId={3} />)

    await screen.findByText("Hielo")
    await user.type(screen.getByRole("searchbox", { name: "Buscar insumo" }), "limon")
    expect(screen.getByText("Limón tahití")).toBeInTheDocument()
    expect(screen.queryByText("Hielo")).toBeNull()
    const recuento = screen.getByText(/de/, { selector: "p" })
    expect(recuento.textContent).toContain("1 de 3 insumos")
    expect(recuento.textContent).toContain("2 no coinciden con «limon»")
    // La búsqueda es local: al servidor nunca le llega un nombre.
    for (const [args] of getInventoryStockMock.mock.calls) expect(args).not.toHaveProperty("name")
  })

  it("«Sin costo» va rayado (`.sin-dato`), no en $ 0; el costo que existe dice su origen", async () => {
    renderWithProviders(<StockTab storeId={3} />)

    const hielo = within((await screen.findByText("Hielo")).closest("tr") as HTMLElement)
    expect(hielo.getByText("Sin costo").className).toContain("sin-dato")
    const limon = within(screen.getByText("Limón tahití").closest("tr") as HTMLElement)
    expect(limon.getByText("promedio ponderado")).toBeInTheDocument()
  })

  it("el estado lleva forma y palabra, y la franja de la fila dice la gravedad", async () => {
    renderWithProviders(<StockTab storeId={3} />)

    const pollo = (await screen.findByText("Pechuga de pollo")).closest("tr") as HTMLElement
    expect(pollo).toHaveAttribute("data-status", "critical")
    expect(within(pollo).getByText("Negativo").querySelector(".semaforo-red")).not.toBeNull()
    expect(within(screen.getByText("Hielo").closest("tr") as HTMLElement).getByText("Al día")).toBeInTheDocument()
  })

  it("el «⋯» trae ficha, ajuste, libro y —con conteo por área— recuento, con la nota «Nada se borra»", async () => {
    const user = userEvent.setup()
    renderWithProviders(<StockTab storeId={3} />, { me: buildMe({ features: { "inventory.shift_counts": true } }) })

    await user.click(await screen.findByRole("button", { name: "Acciones de Hielo" }))
    const menu = await screen.findByRole("menu")
    for (const accion of ["Ver ficha del insumo", "Ajustar con motivo", "Pedir recuento", "Ver libro de movimientos"]) {
      expect(within(menu).getByRole("menuitem", { name: accion })).toBeInTheDocument()
    }
    expect(within(menu).getByText("Nada se borra: los ajustes quedan en el libro con motivo.")).toBeInTheDocument()

    // «Ajustar con motivo» abre el ajuste de siempre (PIN y motivo), con el insumo ya elegido.
    await user.click(within(menu).getByRole("menuitem", { name: "Ajustar con motivo" }))
    const dialogo = await screen.findByRole("dialog")
    expect(within(dialogo).getByText("Ajuste manual de inventario")).toBeInTheDocument()
    expect(within(dialogo).getByText("Hielo")).toBeInTheDocument()
  })

  it("sin conteo por área no se ofrece «Pedir recuento»; sin compras no hay «Registrar compra»", async () => {
    const user = userEvent.setup()
    renderWithProviders(<StockTab storeId={3} />, {
      me: buildMe({ features: { "inventory.shift_counts": false, purchases: false } }),
    })

    await user.click(await screen.findByRole("button", { name: "Acciones de Hielo" }))
    const menu = await screen.findByRole("menu")
    expect(within(menu).queryByRole("menuitem", { name: "Pedir recuento" })).toBeNull()
    expect(screen.queryByRole("link", { name: "Registrar compra" })).toBeNull()
  })

  it("con compras, la acción primaria baja a la barra de la tabla", async () => {
    renderWithProviders(<StockTab storeId={3} />, { me: buildMe({ features: { purchases: true } }) })

    expect(await screen.findByRole("link", { name: "Registrar compra" })).toHaveAttribute(
      "href",
      "/admin/compras?tab=recepciones",
    )
  })

  it("Stock tiene su «?», y la ranura del mini gráfico queda para `components/charts`", async () => {
    renderWithProviders(<StockTab storeId={3} />)

    await screen.findByText("Hielo")
    expect(screen.getByRole("button", { name: "¿Qué es Stock?" })).toBeInTheDocument()
    // Todavía sin bullet: lo enchufa el trabajo de gráficos por `DenseColumn.bullet`.
    expect(document.querySelector('[data-slot="bullet"]')).toBeNull()
  })
})
