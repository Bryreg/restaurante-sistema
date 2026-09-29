import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import jsQR from "jsqr"
import qrcode from "qrcode-generator"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { Me } from "@/api/auth"
import type { FoodLabel, LabelSources } from "@/api/labels"
import { renderWithProviders } from "@/test/utils"

import { LabelsPage } from "../LabelsPage"
import { stateText } from "../lib"
import { codeText, labelHtml, labelsDocument, qrPayload, shortName } from "../printLabels"

const mocks = vi.hoisted(() => ({
  getLabelBoard: vi.fn(),
  getLabelSources: vi.fn(),
  getDeviceLabelSettings: vi.fn(),
  getLabelByCode: vi.fn(),
  createLabels: vi.fn(),
  reprintLabel: vi.fn(),
  finishLabel: vi.fn(),
  printLabels: vi.fn(),
}))

vi.mock("@/api/labels", async () => {
  const actual = await vi.importActual<typeof import("@/api/labels")>("@/api/labels")
  return {
    ...actual,
    getLabelBoard: mocks.getLabelBoard,
    getLabelSources: mocks.getLabelSources,
    getDeviceLabelSettings: mocks.getDeviceLabelSettings,
    getLabelByCode: mocks.getLabelByCode,
    createLabels: mocks.createLabels,
    reprintLabel: mocks.reprintLabel,
    finishLabel: mocks.finishLabel,
  }
})

vi.mock("../printLabels", async () => {
  const actual = await vi.importActual<typeof import("../printLabels")>("../printLabels")
  return { ...actual, printLabels: mocks.printLabels }
})

function deviceMe(features: Record<string, boolean>): Me {
  return {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: ["counter"] },
    employee: { id: 2, name: "Luz Marina Gómez", role: "operator", can_charge: false },
    employee_expires_at: null,
    organization: { id: 1, name: "Organización de prueba" },
    features,
  }
}

function label(overrides: Partial<FoodLabel> = {}): FoodLabel {
  return {
    id: 1,
    code: "K7Q2M9XH",
    kind: "opened",
    ingredient_id: 5,
    preparation_id: null,
    stock_batch_id: 9,
    prep_batch_id: null,
    reception_draft_line_id: null,
    item_name: "Queso mozzarella",
    lot_code: "QZ-77",
    qty_text: "1 kg",
    note: null,
    made_at: "2026-09-29T19:20:00Z",
    business_date: "2026-09-29",
    use_by: "2026-10-04",
    use_by_source: "opened_shelf_life",
    employee_name: "Luz Marina Gómez",
    status: "active",
    closed_at: null,
    closed_by_employee_name: null,
    waste_id: null,
    print_count: 1,
    days_left: 5,
    state: "ok",
    waste_unit: "kg",
    ...overrides,
  }
}

const SOURCES: LabelSources = {
  business_date: "2026-09-29",
  openable: [
    {
      ingredient_id: 5,
      name: "Queso mozzarella",
      category: "Lácteos",
      perishable: true,
      opened_shelf_life_days: 5,
      next_batch: { stock_batch_id: 9, lot_code: "QZ-77", expires_at: "2026-10-20" },
      use_by_preview: "2026-10-04",
      use_by_source_preview: "opened_shelf_life",
    },
    {
      ingredient_id: 6,
      name: "Salsa negra",
      category: null,
      perishable: false,
      opened_shelf_life_days: null,
      next_batch: null,
      use_by_preview: null,
      use_by_source_preview: null,
    },
  ],
  received: [],
  produced: [],
}

describe("la etiqueta impresa", () => {
  it("lleva nombre, «usar antes de», lote, contenido, quién y el código legible", () => {
    const html = labelHtml(label())
    expect(html).toContain("Queso mozzarella")
    expect(html).toContain("Usar antes de")
    expect(html).toContain("dom 4 oct")
    expect(html).toContain("Lote QZ-77 · 1 kg")
    expect(html).toContain("Luz M. · K7Q2 M9XH")
    expect(html).toContain("Abierto 29 sep 2:20 pm")
    expect(html).toContain("<svg")
  })

  it("lo recibido sin vencimiento dice «Sin vencimiento», nunca una fecha inventada", () => {
    expect(labelHtml(label({ kind: "received", use_by: null, state: "no_date" }))).toContain("Sin vencimiento")
  })

  it("escapa el texto: un nombre con < no rompe la etiqueta", () => {
    expect(labelHtml(label({ item_name: "Salsa <picante>" }))).toContain("Salsa &lt;picante&gt;")
  })

  it("la página mide lo que el rollo (Ajustes) y cada etiqueta es una página", () => {
    const doc = labelsDocument([label(), label({ id: 2, code: "AAAABBBB" })], { width_mm: 62, height_mm: 29 })
    expect(doc).toContain("@page { size: 62mm 29mm; margin: 0; }")
    expect(doc.match(/<section class="label">/g)).toHaveLength(2)
  })

  it("el QR se lee y devuelve ET-<código>", () => {
    const qr = qrcode(0, "M")
    qr.addData(qrPayload("K7Q2M9XH"), "Alphanumeric")
    qr.make()
    const n = qr.getModuleCount()
    const scale = 4
    const quiet = 4
    const size = (n + quiet * 2) * scale
    const data = new Uint8ClampedArray(size * size * 4).fill(255)
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue
        for (let y = 0; y < scale; y++) {
          for (let x = 0; x < scale; x++) {
            const i = (((r + quiet) * scale + y) * size + (c + quiet) * scale + x) * 4
            data[i] = data[i + 1] = data[i + 2] = 0
          }
        }
      }
    }
    expect(jsQR(data, size, size)?.data).toBe("ET-K7Q2M9XH")
  })

  it("nombres y códigos cortos para una etiqueta chica", () => {
    expect(shortName("Luz Marina Gómez")).toBe("Luz M.")
    expect(shortName("Operador")).toBe("Operador")
    expect(codeText("K7Q2M9XH")).toBe("K7Q2 M9XH")
  })

  it("el estado se dice como en cocina", () => {
    expect(stateText(label({ state: "expired", days_left: -1 }))).toBe("Venció ayer")
    expect(stateText(label({ state: "expired", days_left: -3 }))).toBe("Venció hace 3 días")
    expect(stateText(label({ state: "today", days_left: 0 }))).toBe("Vence hoy")
    expect(stateText(label({ state: "tomorrow", days_left: 1 }))).toBe("Vence mañana")
    expect(stateText(label())).toBe("Quedan 5 días · dom 4 oct")
  })
})

describe("LabelsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDeviceLabelSettings.mockResolvedValue({ store_id: 1, width_mm: 50, height_mm: 30 })
    mocks.getLabelSources.mockResolvedValue(SOURCES)
    mocks.printLabels.mockReturnValue(true)
  })

  it("apagada no pide nada al servidor y dice dónde se enciende", () => {
    renderWithProviders(<LabelsPage />, { me: deviceMe({ "inventory.labels": false }), route: "/pos/etiquetas" })
    expect(screen.getByText("Las etiquetas están apagadas")).toBeInTheDocument()
    expect(mocks.getLabelBoard).not.toHaveBeenCalled()
  })

  it("«En la cocina» muestra lo vencido arriba, en rojo, con lo que dijo el servidor", async () => {
    mocks.getLabelBoard.mockResolvedValue({
      business_date: "2026-09-29",
      labels: [label({ id: 3, item_name: "Leche", state: "expired", days_left: -2, use_by: "2026-09-27" }), label()],
      expired: 1,
      today: 0,
      tomorrow: 0,
    })
    renderWithProviders(<LabelsPage />, { me: deviceMe({ "inventory.labels": true }), route: "/pos/etiquetas" })
    expect(await screen.findByText("Venció hace 2 días")).toBeInTheDocument()
    expect(screen.getByText(/1 vencida\(s\) en la cocina/)).toBeInTheDocument()
    const items = screen.getAllByRole("listitem")
    expect(within(items[0]).getByText("Leche")).toBeInTheDocument()
  })

  it("«Abrí algo»: elegir el insumo, ver la fecha que calculó el servidor e imprimir las copias", async () => {
    const user = userEvent.setup()
    mocks.getLabelBoard.mockResolvedValue({ business_date: "2026-09-29", labels: [], expired: 0, today: 0, tomorrow: 0 })
    mocks.createLabels.mockResolvedValue({ labels: [label(), label({ id: 2, code: "AAAABBBB" })] })
    renderWithProviders(<LabelsPage />, {
      me: deviceMe({ "inventory.labels": true }),
      route: "/pos/etiquetas?tab=abri",
    })

    await user.click(await screen.findByRole("button", { name: /Queso mozzarella/ }))
    expect(screen.getByText("dom 4 oct")).toBeInTheDocument()
    expect(screen.getByText(/días que dura abierto/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Una más" }))
    await user.type(screen.getByLabelText("Contenido (opcional)"), "1 kg")
    await user.click(screen.getByRole("button", { name: "Imprimir 2 etiquetas" }))

    await waitFor(() => expect(mocks.createLabels).toHaveBeenCalledTimes(1))
    expect(mocks.createLabels.mock.calls[0][0]).toEqual({
      kind: "opened",
      ingredient_id: 5,
      stock_batch_id: 9,
      copies: 2,
      qty_text: "1 kg",
      use_by: null,
    })
    await waitFor(() => expect(mocks.printLabels).toHaveBeenCalledTimes(1))
    expect(mocks.printLabels.mock.calls[0][1]).toEqual({ store_id: 1, width_mm: 50, height_mm: 30 })
  })

  it("sin regla de vencimiento no deja imprimir hasta poner la fecha", async () => {
    const user = userEvent.setup()
    mocks.getLabelBoard.mockResolvedValue({ business_date: "2026-09-29", labels: [], expired: 0, today: 0, tomorrow: 0 })
    renderWithProviders(<LabelsPage />, {
      me: deviceMe({ "inventory.labels": true }),
      route: "/pos/etiquetas?tab=abri",
    })
    await user.click(await screen.findByRole("button", { name: /Salsa negra/ }))
    expect(screen.getByText(/no tiene regla/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Imprimir etiqueta" })).toBeDisabled()
  })

  it("leer un código abre la ficha, y «Se acabó» la cierra", async () => {
    const user = userEvent.setup()
    mocks.getLabelBoard.mockResolvedValue({ business_date: "2026-09-29", labels: [], expired: 0, today: 0, tomorrow: 0 })
    mocks.getLabelByCode.mockResolvedValue(label())
    mocks.finishLabel.mockResolvedValue(label({ status: "used_up" }))
    renderWithProviders(<LabelsPage />, { me: deviceMe({ "inventory.labels": true }), route: "/pos/etiquetas" })

    await user.type(screen.getByLabelText("Leer una etiqueta"), "et-k7q2m9xh{Enter}")
    expect(mocks.getLabelByCode).toHaveBeenCalledWith("et-k7q2m9xh", expect.anything())
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Queso mozzarella")).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Se acabó" }))
    await waitFor(() => expect(mocks.finishLabel).toHaveBeenCalledTimes(1))
    expect(mocks.finishLabel.mock.calls[0].slice(0, 2)).toEqual(["K7Q2M9XH", { outcome: "used_up" }])
  })

  it("botar pide cuánto (en la unidad del insumo) y el PIN: es una merma", async () => {
    const user = userEvent.setup()
    mocks.getLabelBoard.mockResolvedValue({ business_date: "2026-09-29", labels: [], expired: 0, today: 0, tomorrow: 0 })
    mocks.getLabelByCode.mockResolvedValue(label({ state: "expired", days_left: -1 }))
    mocks.finishLabel.mockResolvedValue(label({ status: "discarded" }))
    renderWithProviders(<LabelsPage />, {
      me: deviceMe({ "inventory.labels": true, "inventory.waste": true }),
      route: "/pos/etiquetas",
    })

    await user.type(screen.getByLabelText("Leer una etiqueta"), "K7Q2M9XH{Enter}")
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Botar" }))
    await user.type(within(dialog).getByLabelText("¿Cuánto se botó? (en kg)"), "0,5")
    for (const digit of "5555") {
      await user.click(within(dialog).getByRole("button", { name: `Dígito ${digit}` }))
    }
    await waitFor(() => expect(mocks.finishLabel).toHaveBeenCalledTimes(1))
    expect(mocks.finishLabel.mock.calls[0][1]).toEqual({
      outcome: "discarded",
      qty: "0.5",
      waste_type: "expired",
      employee_pin: "5555",
      note: null,
    })
  })
})
