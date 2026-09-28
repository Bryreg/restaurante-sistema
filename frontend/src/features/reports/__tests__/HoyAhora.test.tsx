import { screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { StorePanelOut } from "@/api/panel"
import { buildMe, renderWithProviders } from "@/test/utils"

import { PanelAhora } from "../PanelAhora"

/**
 * «Ahora» con barra + raya (handoff, `AdminHoy` variante A): las cifras y
 * de qué lado de la raya quedó cada punto vienen del servidor; la pantalla
 * sólo las dibuja y las escribe.
 */

const { getPanel, getToday } = vi.hoisted(() => ({ getPanel: vi.fn(), getToday: vi.fn() }))

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({
    stores: [
      { id: 1, name: "Chapinero" },
      { id: 2, name: "Salitre" },
    ],
    loading: false,
    activeStoreId: 1,
    setActiveStoreId: vi.fn(),
  }),
}))
vi.mock("@/api/panel", async () => {
  const actual = await vi.importActual<typeof import("@/api/panel")>("@/api/panel")
  return { ...actual, getPanel }
})
vi.mock("@/api/reports", async () => {
  const actual = await vi.importActual<typeof import("@/api/reports")>("@/api/reports")
  return { ...actual, getToday }
})

const p = (key: string, value: number | null, extra: object = {}) => ({
  key,
  label: key,
  value,
  reference: null,
  delta_bp: null,
  outside: false,
  future: false,
  now: false,
  ...extra,
})

function chapinero(): StorePanelOut {
  return {
    store_id: 1,
    store_name: "Chapinero",
    business_date: "2026-09-27",
    light: "amber",
    reasons: [
      { key: "cash_over_threshold", level: "warning", text: "Efectivo sobre el umbral: conviene un retiro." },
      { key: "kitchen_late", level: "warning", text: "2 platos pasados de su tiempo en cocina." },
    ],
    closed: false,
    cash: {
      shift_id: 12,
      business_date: "2026-09-27",
      opened_at: "2026-09-27T12:02:00Z",
      responsible: { id: 3, name: "Kevin Ruiz", active: true },
      is_stale: false,
      stale_since: null,
      cash_over_threshold: true,
      expected_cash: 1_412_000,
    },
    staff: {
      present: [{ employee_id: 3, name: "Kevin Ruiz", since: "2026-09-27T12:00:00Z", on_pause: false, active: true }],
      pending_review: [],
      reason: null,
    },
    area_counts: { enabled: true, areas_total: 2, opening_done: 1, opening_missing: 0, closing_done: 0, flagged: 0, pending_recounts: 0 },
    salon: { tables_occupied: 2, tables_total: 12, open_orders: 2, unsent: 0, unpaid: 0 },
    kitchen: { enabled: true, in_kitchen: 2, late: 1, very_late: 0, oldest_late_minutes: 26 },
    pending: {
      deposits_to_confirm: 0,
      requests_pending: 0,
      novelties_open: 0,
      novelties_urgent: 0,
      unreviewed_closes: 0,
      reserve_loans_open: 0,
      reserve_loans_total: null,
      attendance_review: 0,
    },
    bullets: {
      sales: { value: 2_635_648, reference: 2_498_000, bad_side: "below", outside: false, delta_bp: 551, over_by: null, reason: null },
      reference_business_date: "2026-09-20",
      cash: { value: 1_412_000, reference: 1_200_000, bad_side: "above", outside: true, delta_bp: null, over_by: 212_000, reason: null },
      staff_by_hour: {
        available: true,
        reason: "Lo que viene es una proyección.",
        unit: "people",
        bad_side: "below",
        reference: null,
        points: [p("6", 1), p("7", 3, { now: true }), p("8", 3, { future: true })],
      },
      area_progress: [
        { area_id: 1, area_name: "Cocina", counted: 6, total: 8, behind: false },
        { area_id: 2, area_name: "Bar", counted: 3, total: 8, behind: true },
      ],
      tables: {
        available: true,
        reason: null,
        unit: "minutes",
        bad_side: "above",
        reference: 60,
        points: [p("M2", 38), p("M3", 72, { outside: true })],
      },
      tickets: {
        available: true,
        reason: null,
        unit: "minutes",
        bad_side: "above",
        reference: 20,
        points: [p("M11", 26, { outside: true }), p("M6", 16)],
      },
      generated_at: "2026-09-27T17:53:00Z",
    },
  }
}

function salitre(): StorePanelOut {
  return { ...chapinero(), store_id: 2, store_name: "Salitre", light: "gray", reasons: [], closed: true, cash: null, bullets: null }
}

beforeEach(() => {
  getPanel.mockReset()
  getToday.mockReset()
  getPanel.mockResolvedValue({ scope: "all", generated_at: "2026-09-27T17:53:00Z", stores: [chapinero(), salitre()] })
  getToday.mockResolvedValue({ store_id: 1, business_date: "2026-09-27", orders: 38 })
})

describe("Hoy · Ahora (variante A)", () => {
  it("el semáforo dice cada sede con forma, palabra y razones", async () => {
    renderWithProviders(<PanelAhora />, { me: buildMe() })

    const semaforo = await screen.findByRole("list", { name: "Todas las sedes ahora" })
    const [cha, sal] = within(semaforo).getAllByRole("button")
    expect(cha).toHaveTextContent("ChapineroAtención")
    expect(cha).toHaveTextContent("Efectivo sobre el umbral: conviene un retiro.")
    expect(cha!.querySelector("[data-forma='amber']")).not.toBeNull()
    expect(cha).toHaveAttribute("aria-pressed", "true")
    expect(sal).toHaveTextContent("SalitreCerrado")
    expect(sal).toHaveTextContent("Sin turno ni actividad")
  })

  it("Caja: ventas contra el mismo día a esta hora y efectivo contra el umbral, con lo que lo pasa", async () => {
    renderWithProviders(<PanelAhora />, { me: buildMe() })

    const caja = await screen.findByRole("region", { name: "Caja" })
    expect(within(caja).getByText("▲ Retiro sugerido")).toBeInTheDocument()
    expect(await within(caja).findByText("ventas netas · 38 comandas")).toBeInTheDocument()
    expect(within(caja).getByText(/Raya: dom 20 a esta hora, \$ 2\.498\.000 · ▲ 5,5/)).toBeInTheDocument()
    expect(within(caja).getByText("Raya: umbral de retiro $ 1.200.000 · lo pasa por $ 212.000")).toBeInTheDocument()
    const [ventas, efectivo] = within(caja).getAllByRole("img")
    expect(ventas).not.toHaveAttribute("data-fuera")
    expect(efectivo).toHaveAttribute("data-fuera")
    expect(within(caja).getByRole("link", { name: /Ficha del turno/ })).toHaveAttribute("href", "/admin/dinero/turno/12")
  })

  it("mesas en ámbar y tiquetes en rojo cuando pasan su límite; lo que viene al 35 %", async () => {
    renderWithProviders(<PanelAhora />, { me: buildMe() })

    const salon = await screen.findByRole("region", { name: "Salón" })
    const mesas = within(salon).getByRole("img")
    expect(mesas.querySelectorAll("[data-fuera]")).toHaveLength(1)
    expect(mesas.querySelector("[data-fuera]")).toHaveClass("bg-warning")
    expect(within(salon).getByText("1 hora")).toBeInTheDocument()

    const cocina = screen.getByRole("region", { name: "Cocina" })
    expect(within(cocina).getByText("■ 1 plato atrasado")).toBeInTheDocument()
    expect(within(cocina).getByRole("img").querySelector("[data-fuera]")).toHaveClass("bg-destructive")

    const gente = screen.getByRole("region", { name: "Quién trabaja" })
    const barras = within(gente).getByRole("img")
    expect(barras.querySelector("[data-ahora]")).toHaveClass("bg-foreground")
    expect(barras.querySelector("[data-futuro]")).toHaveClass("opacity-35")
    expect(within(gente).getByText("ahora")).toBeInTheDocument()

    const conteos = screen.getByRole("region", { name: "Conteos de apertura" })
    expect(within(conteos).getByText("3 de 8")).toHaveClass("text-warning")
    expect(within(conteos).getByText("6 de 8")).toHaveClass("text-foreground")
  })
})

/**
 * Una sede con pocos datos (lo que se ve en producción: un turno abandonado
 * de días, comandas viejas en cocina, nadie con entrada). `null` sigue sin
 * ser 0, pero se dice en calma: ni bloques rayados ni gráficos vacíos.
 */
describe("Hoy · Ahora con pocos datos", () => {
  function flojo(): StorePanelOut {
    const base = chapinero()
    return {
      ...base,
      light: "red",
      reasons: [{ key: "shift_stale", level: "critical", text: "Turno abandonado: sigue abierto desde el mié 16 sep." }],
      cash: { ...base.cash!, is_stale: true, business_date: "2026-09-16", cash_over_threshold: false },
      staff: { present: [], pending_review: [], reason: "Nadie marcó entrada hoy." },
      area_counts: { ...base.area_counts, areas_total: 0, opening_done: 0 },
      kitchen: { enabled: true, in_kitchen: 2, late: 2, very_late: 2, oldest_late_minutes: 17_260 },
      bullets: {
        ...base.bullets!,
        sales: { value: 0, reference: 0, bad_side: "below", outside: false, delta_bp: null, over_by: null, reason: null },
        staff_by_hour: {
          ...base.bullets!.staff_by_hour!,
          points: [p("6", 0), p("7", 0, { now: true }), p("8", 0, { future: true })],
        },
      },
    }
  }

  beforeEach(() => {
    getPanel.mockResolvedValue({ scope: "one", generated_at: "2026-09-27T17:53:00Z", stores: [flojo()] })
    getToday.mockResolvedValue({ store_id: 1, business_date: "2026-09-27", orders: 0 })
  })

  it("una sola sede es una tarjeta a lo ancho, con la fecha como la lee el dueño", async () => {
    renderWithProviders(<PanelAhora />, { me: buildMe() })
    const semaforo = await screen.findByRole("list", { name: "Todas las sedes ahora" })
    expect(semaforo.className).toContain("auto-fit")
    expect(within(semaforo).getByRole("button")).toHaveTextContent("desde el mié 16 sep")
  })

  it("sin ventas ni raya: una línea, no una barra vacía con la raya pegada al borde", async () => {
    renderWithProviders(<PanelAhora />, { me: buildMe() })
    const caja = await screen.findByRole("region", { name: "Caja" })
    expect(within(caja).getByText(/Todavía no hay ventas hoy; el dom 20 a esta hora tampoco había/)).toBeInTheDocument()
    // Sólo queda el bullet del efectivo.
    expect(within(caja).getAllByRole("img")).toHaveLength(1)
  })

  it("nadie en turno: una frase apagada y ningún gráfico de ceros ni rayado", async () => {
    const { container } = renderWithProviders(<PanelAhora />, { me: buildMe() })
    const gente = await screen.findByRole("region", { name: "Quién trabaja" })
    expect(within(gente).queryByRole("img")).not.toBeInTheDocument()
    expect(within(gente).getByText("Nadie marcó entrada hoy.")).toBeInTheDocument()
    // En todo «Ahora» no queda una sola trama de «sin dato».
    expect(container.querySelectorAll(".sin-dato:not(.sin-dato--calmo)")).toHaveLength(0)
  })

  it("un tiquete de otro día no se escribe en horas: se dice que no es de este servicio", async () => {
    renderWithProviders(<PanelAhora />, { me: buildMe() })
    const cocina = await screen.findByRole("region", { name: "Cocina" })
    expect(within(cocina).getByText(/es de otro día/)).toBeInTheDocument()
    expect(within(cocina).queryByText(/287 h/)).not.toBeInTheDocument()
  })
})
