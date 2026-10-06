import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SectionCardOut, SectionOut } from "@/api/panel"
import { buildMe, renderWithProviders } from "@/test/utils"

import { CajaMovil, EquipoMovil } from "../movil/SeccionMovil"

/**
 * Caja, Equipo e Informes en el celular (handoff, `MovilSecciones`
 * variante A): cuatro tarjetas; la elegida abre su detalle debajo. Las
 * cifras llegan hechas del servidor; la pantalla sólo las escribe.
 */

const getPanelSection = vi.hoisted(() => vi.fn())

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({
    stores: [
      { id: 1, name: "Chapinero" },
      { id: 2, name: "Usaquén" },
    ],
    loading: false,
    activeStoreId: 1,
    setActiveStoreId: vi.fn(),
  }),
}))
vi.mock("@/api/panel", async () => {
  const actual = await vi.importActual<typeof import("@/api/panel")>("@/api/panel")
  return { ...actual, getPanelSection }
})

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}

const punto = (key: string, value: number | null, extra: object = {}) => ({
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

function card(overrides: Partial<SectionCardOut>): SectionCardOut {
  return {
    key: "closes",
    available: true,
    reason: null,
    unit: "count",
    value: null,
    of: null,
    value_text: null,
    tone: "ok",
    status: null,
    note: null,
    chart: "columns",
    series: { available: true, reason: null, unit: "count", bad_side: "above", reference: null, points: [] },
    rows: [],
    ...overrides,
  }
}

const CAJA: SectionOut = {
  section: "caja",
  scope: "all",
  store_ids: [1, 2],
  generated_at: "2026-09-27T17:55:00Z",
  cards: [
    card({
      key: "closes",
      value: 2,
      of: 4,
      tone: "critical",
      status: "1 faltante · 1 sin cerrar",
      note: "Diferencia total de cierre por día, todas las sedes. Arriba sobra, abajo falta.",
      chart: "diverging",
      series: {
        available: true,
        reason: null,
        unit: "cop",
        bad_side: "below",
        reference: 0,
        points: [punto("2026-09-25", 0), punto("2026-09-26", -4_000, { outside: true, now: true, label: "ayer" })],
      },
      rows: [
        { key: "1", label: "Chapinero · cerró Diana Pérez", value: -4_000, unit: "cop", note: null, tone: "critical" },
        { key: "3", label: "Cedritos · nadie cerró", value: null, unit: "cop", note: "Sin cierre", tone: "critical" },
        { key: "2", label: "Usaquén · cerró Paula Ríos", value: 0, unit: "cop", note: "Cuadra", tone: "ok" },
      ],
    }),
    card({
      key: "deposits",
      unit: "cop",
      value: 1_240_000,
      tone: "warning",
      status: "1 por confirmar",
      rows: [{ key: "41", label: "Chapinero · consignó Kevin Ruiz · vie 26 11:05 a. m.", value: 1_240_000, unit: "cop", note: null, tone: "warning" }],
    }),
    card({ key: "pickups", unit: "cop", value: null, tone: "muted", status: "Sin retiros hoy" }),
    card({ key: "expenses", unit: "cop", value: 73_000, tone: "ok", status: "3 gastos, todos con foto" }),
  ],
}

beforeEach(() => {
  getPanelSection.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Caja en el celular", () => {
  it("cuatro tarjetas; la primera abre su detalle con la cifra, el gráfico, las excepciones y la acción", async () => {
    stubMatchMedia(true)
    getPanelSection.mockResolvedValue(CAJA)
    renderWithProviders(<CajaMovil />, { me: buildMe() })

    const grupo = await screen.findByRole("group", { name: "Las preguntas de Caja" })
    // Con dos sedes, todas juntas.
    expect(getPanelSection).toHaveBeenCalledWith("caja", "all")
    const tarjetas = within(grupo).getAllByRole("button")
    expect(tarjetas.map((t) => t.querySelector("span")?.textContent)).toEqual([
      "Cuadre de ayer",
      "Consignaciones",
      "Retiros hoy",
      "Gastos de caja",
    ])
    expect(tarjetas[0]).toHaveAttribute("aria-pressed", "true")
    expect(within(tarjetas[0]!).getByText("2 de 4")).toBeInTheDocument()
    // `null` no es $ 0: sin dato, rayado.
    // Cambio intencional (pulido del panel): la cifra sin dato es «—» apagado
    // con «Sin dato» para el lector de pantalla, no un bloque rayado; la marca
    // `.sin-dato` sigue en la cifra.
    const sinDato = within(tarjetas[2]!).getByText("Sin dato").closest(".sin-dato")
    expect(sinDato).not.toBeNull()
    expect(sinDato!.textContent).toContain("—")

    const detalle = screen.getByRole("region", { name: "¿Cuadraron los turnos de ayer?" })
    expect(within(detalle).getByText("2 de 4")).toBeInTheDocument()
    expect(within(detalle).getByRole("img")).toHaveAttribute("data-slot", "serie-mini")
    const renglones = within(detalle).getAllByRole("listitem")
    expect(renglones[0]).toHaveTextContent("Chapinero · cerró Diana Pérez▼ −$ 4.000")
    expect(renglones[1]).toHaveTextContent("Cedritos · nadie cerróSin cierre")
    expect(renglones[2]).toHaveTextContent("Usaquén · cerró Paula RíosCuadra")
    expect(within(detalle).getByRole("link", { name: "Ver turnos de ayer" })).toHaveAttribute(
      "href",
      "/admin/dinero?tab=historial",
    )
  })

  it("tocar otra tarjeta cambia el detalle (estado local)", async () => {
    stubMatchMedia(true)
    getPanelSection.mockResolvedValue(CAJA)
    const user = userEvent.setup()
    renderWithProviders(<CajaMovil />, { me: buildMe() })

    const grupo = await screen.findByRole("group", { name: "Las preguntas de Caja" })
    await user.click(within(grupo).getByRole("button", { name: /Consignaciones/ }))
    expect(within(grupo).getByRole("button", { name: /Consignaciones/ })).toHaveAttribute("aria-pressed", "true")
    const detalle = screen.getByRole("region", { name: "¿Qué consignaciones faltan por confirmar?" })
    expect(within(detalle).getAllByText("$ 1.240.000").length).toBeGreaterThan(0)
    // La acción lleva a Hoy › Requiere tu atención, donde se confirma con la foto.
    expect(within(detalle).getByRole("link", { name: "Confirmar con la foto" })).toHaveAttribute(
      "href",
      "/admin/hoy#requiere-atencion",
    )
  })

  it("una tarjeta sin dato dice por qué (Consignaciones apagada)", async () => {
    stubMatchMedia(true)
    getPanelSection.mockResolvedValue({
      ...CAJA,
      section: "equipo",
      cards: [
        card({ key: "deposits", unit: "cop", available: false, reason: "La función «Consignaciones» está apagada en estas sedes.", tone: "muted" }),
        card({ key: "staff", unit: "people", value: 15, status: "Nadie en pausa" }),
        card({ key: "exits", value: 1, tone: "warning", status: "Jhon Pérez" }),
        card({ key: "hours", unit: "minutes", value: 29_160, status: "Sin horas programadas para comparar" }),
      ],
    })
    renderWithProviders(<EquipoMovil />, { me: buildMe() })

    const detalle = await screen.findByRole("region", { name: "¿Qué consignaciones faltan por confirmar?" })
    expect(within(detalle).getByText(/Consignaciones» está apagada/).closest(".sin-dato")).not.toBeNull()
    const grupo = screen.getByRole("group", { name: "Las preguntas de Equipo" })
    // Las horas se escriben en horas, no en minutos.
    expect(within(grupo).getByText("486 h")).toBeInTheDocument()
    // «Llegadas tarde» se quitó en la limpieza 2026-10 (no había horario
    // programado) y volvió con la planeación de turnos (auditoría e1): un
    // servidor que no la manda no la dibuja.
    expect(within(grupo).queryByText("Llegadas tarde")).not.toBeInTheDocument()
  })

  it("«Llegadas tarde» vuelve con la planeación: la cifra y quién, tal como los manda el servidor, y lleva a Planeación", async () => {
    stubMatchMedia(true)
    getPanelSection.mockResolvedValue({
      ...CAJA,
      section: "equipo",
      cards: [
        card({
          key: "late",
          unit: "count",
          value: 2,
          of: 6,
          tone: "critical",
          status: "1 tarde · 1 no vino",
          rows: [
            { key: "1-7", label: "Ana · Centro · planeado 07:00, entró 7:12 a. m.", value: 12, unit: "minutes", note: null, tone: "warning" },
            { key: "1-8", label: "Luis · Centro · planeado 06:00", value: null, unit: "count", note: "No vino", tone: "critical" },
          ],
        }),
        card({ key: "staff", unit: "people", value: 4, status: "Nadie en pausa" }),
      ],
    })
    renderWithProviders(<EquipoMovil />, { me: buildMe() })

    const detalle = await screen.findByRole("region", { name: "¿Quién llegó tarde hoy?" })
    expect(within(detalle).getByText(/No vino/)).toBeInTheDocument()
    expect(within(detalle).getByRole("link", { name: "Ver la planeación" })).toHaveAttribute("href", "/admin/nomina?tab=planeacion")
    const grupo = screen.getByRole("group", { name: "Las preguntas de Equipo" })
    expect(within(grupo).getByText("Llegadas tarde")).toBeInTheDocument()
  })

  it("una serie toda vacía no dibuja un eje de marcas: dice en una línea que no hay nada que dibujar", async () => {
    stubMatchMedia(true)
    const vacia = [punto("2026-09-25", null), punto("2026-09-26", null, { label: "ayer" })]
    getPanelSection.mockResolvedValue({
      ...CAJA,
      cards: [
        card({
          key: "closes",
          value: null,
          tone: "muted",
          status: "Ayer no abrió ninguna sede",
          chart: "diverging",
          series: { available: true, reason: null, unit: "cop", bad_side: "below", reference: 0, points: vacia },
        }),
        ...CAJA.cards.slice(1),
      ],
    })
    renderWithProviders(<CajaMovil />, { me: buildMe() })

    const detalle = await screen.findByRole("region", { name: "¿Cuadraron los turnos de ayer?" })
    expect(within(detalle).queryByRole("img")).not.toBeInTheDocument()
    expect(within(detalle).getByText(/Nada que dibujar en estos días/)).toBeInTheDocument()
    // La tarjeta tampoco lleva mini tendencia de huecos.
    const grupo = screen.getByRole("group", { name: "Las preguntas de Caja" })
    expect(within(grupo).getAllByRole("button")[0]!.querySelector('[data-slot="serie-mini"]')).toBeNull()
  })

  it("en el escritorio manda a la pantalla de la sección", async () => {
    stubMatchMedia(false)
    renderWithProviders(
      <Routes>
        <Route path="/admin/celular/caja" element={<CajaMovil />} />
        <Route path="/admin/dinero" element={<p>Dinero de escritorio</p>} />
      </Routes>,
      { me: buildMe(), route: "/admin/celular/caja" },
    )
    expect(await screen.findByText("Dinero de escritorio")).toBeInTheDocument()
    expect(getPanelSection).not.toHaveBeenCalled()
  })
})
