import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import {
  BarList,
  ColumnChart,
  DivergingBars,
  Medidor,
  Pareto,
  QuadrantScatter,
  Stacked100,
  ThresholdDots,
  TrendLine,
} from "@/components/charts"
import { escalaRedonda } from "@/components/charts/nucleo"
import { formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"

const FINO = " "

describe("escalaRedonda", () => {
  it("ticks redondos desde 0", () => {
    expect(escalaRedonda([0, 1_234_000]).ticks).toEqual([0, 500_000, 1_000_000, 1_500_000])
    expect(escalaRedonda([37, 81]).ticks).toEqual([0, 50, 100])
  })
  it("todo en cero no rompe la escala", () => {
    expect(escalaRedonda([0, 0]).ticks[0]).toBe(0)
    expect(escalaRedonda([]).max).toBeGreaterThan(0)
  })
})

describe("ColumnChart", () => {
  const horas = [
    { key: "11", etiqueta: "11", valor: 120_000 },
    { key: "12", etiqueta: "12", valor: 480_000 },
    { key: "13", etiqueta: "13", valor: null },
    { key: "14", etiqueta: "14", valor: 0 },
  ]

  it("dibuja columnas y un null como hueco rayado, no como columna de 0", () => {
    const { container } = render(<ColumnChart datos={horas} formato={formatCOP} />)
    expect(screen.getByRole("img")).toHaveAccessibleName(/el más alto es 12 con \$\s480\.000.*1 sin dato/)
    expect(container.querySelector('[data-hueco="13"]')).not.toBeNull()
    expect(container.querySelector('[data-columna="13"]')).toBeNull()
    // Un 0 real es una columna (sin alto), no un hueco.
    expect(container.querySelector('[data-columna="14"]')).not.toBeNull()
    expect(container.querySelector('[data-hueco="14"]')).toBeNull()
  })

  it("eje en 0 con ticks redondos formateados y la referencia rotulada", () => {
    const { container } = render(
      <ColumnChart
        datos={horas}
        formato={formatCOP}
        referencia={{ valor: 200_000, etiqueta: "Promedio" }}
        serieReferencia={[100_000, 300_000, 50_000, null]}
        etiquetaSerieReferencia="Mismo día, semana pasada"
      />,
    )
    const textos = Array.from(container.querySelectorAll("text")).map((t) => t.textContent)
    expect(textos).toContain(formatCOP(0))
    expect(textos).toContain(formatCOP(400_000))
    expect(textos).toContain(`Promedio: ${formatCOP(200_000)}`)
    expect(container.querySelectorAll("[data-referencia-serie]")).toHaveLength(3)
    expect(screen.getByText("Mismo día, semana pasada")).toBeInTheDocument()
  })

  it("con el teclado recorre las columnas y muestra el globo", () => {
    const { container } = render(<ColumnChart datos={horas} formato={formatCOP} />)
    const lienzo = screen.getByRole("img")
    fireEvent.keyDown(lienzo, { key: "ArrowRight" })
    fireEvent.keyDown(lienzo, { key: "ArrowRight" })
    fireEvent.keyDown(lienzo, { key: "ArrowRight" })
    const globo = container.querySelector("[data-chart-globo]")
    expect(globo).toHaveTextContent("13")
    expect(globo).toHaveTextContent("sin dato")
    fireEvent.keyDown(lienzo, { key: "Escape" })
    expect(container.querySelector("[data-chart-globo]")).toBeNull()
  })
})

describe("BarList", () => {
  const datos = [
    { key: "a", etiqueta: "Arepa", valor: 300 },
    { key: "b", etiqueta: "Bandeja", valor: 900 },
    { key: "c", etiqueta: "Caldo", valor: null },
    { key: "d", etiqueta: "Donut", valor: 500 },
    { key: "e", etiqueta: "Empanada", valor: 100 },
  ]

  it("ordena por valor de mayor a menor, con los sin dato al final", () => {
    const { container } = render(<BarList datos={datos} formato={formatCOP} />)
    const orden = Array.from(container.querySelectorAll("[data-barra]")).map((e) => e.getAttribute("data-barra"))
    expect(orden).toEqual(["b", "d", "a", "e", "c"])
    expect(container.querySelector('[data-hueco="c"]')).not.toBeNull()
  })

  it("muestra sólo el top N y ofrece «y N más» sin sumar el resto", () => {
    const { container } = render(
      <MemoryRouter>
        <BarList datos={datos} formato={formatCOP} max={2} enlaceResto={{ texto: "Ver los 3 restantes", to: "/x" }} />
      </MemoryRouter>,
    )
    expect(container.querySelectorAll("[data-barra]")).toHaveLength(2)
    expect(screen.getByRole("link", { name: "Ver los 3 restantes" })).toHaveAttribute("href", "/x")
    // Ninguna cifra sumada: sólo aparecen los valores recibidos.
    expect(screen.queryByText(formatCOP(900))).toBeInTheDocument()
    expect(screen.queryByText(formatCOP(900 + 500 + 300 + 100))).not.toBeInTheDocument()
    expect(screen.queryByText(/Otros/)).not.toBeInTheDocument()
  })

  it("default de 7, y sin marco ni enlace «y N más» es texto", () => {
    const muchos = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, etiqueta: `E${i}`, valor: i }))
    const { container } = render(<BarList datos={muchos} formato={String} />)
    expect(container.querySelectorAll("[data-barra]")).toHaveLength(7)
    expect(screen.getByText("y 2 más")).toBeInTheDocument()
  })
})

describe("TrendLine", () => {
  const puntos = [
    { key: "2026-09-15", etiqueta: "mar 15 sep", valor: 800_000 },
    { key: "2026-09-16", etiqueta: "mié 16 sep", valor: 950_000 },
    { key: "2026-09-17", etiqueta: "jue 17 sep", valor: null },
    { key: "2026-09-18", etiqueta: "vie 18 sep", valor: 1_300_000 },
    { key: "2026-09-19", etiqueta: "sáb 19 sep", valor: 1_700_000 },
  ]

  it("un null corta la línea en dos tramos y queda como hueco", () => {
    const { container } = render(<TrendLine puntos={puntos} formato={formatCOP} />)
    expect(container.querySelectorAll("polyline[data-tramo]")).toHaveLength(2)
    expect(container.querySelector('[data-hueco="2026-09-17"]')).not.toBeNull()
    expect(container.querySelector("svg")).not.toHaveAttribute("preserveAspectRatio", "none")
  })

  it("marca y rotula el último punto, con ticks de Y y fechas en X", () => {
    const { container } = render(
      <TrendLine puntos={puntos} formato={formatCOP} referencia={{ valor: 1_000_000, etiqueta: "Promedio" }} />,
    )
    const ultimo = container.querySelector("[data-ultimo]")
    expect(ultimo).toHaveTextContent(formatCOP(1_700_000))
    const textos = Array.from(container.querySelectorAll("text")).map((t) => t.textContent)
    expect(textos).toContain(formatCOP(0))
    expect(textos).toContain("mar 15 sep")
    expect(textos).toContain("sáb 19 sep")
    expect(textos).toContain(`Promedio: ${formatCOP(1_000_000)}`)
  })

  it("la cruz y el globo siguen al teclado", () => {
    const { container } = render(<TrendLine puntos={puntos} formato={formatCOP} />)
    fireEvent.keyDown(screen.getByRole("img"), { key: "Home" })
    expect(container.querySelector("[data-cruz]")).not.toBeNull()
    expect(container.querySelector("[data-chart-globo]")).toHaveTextContent(formatCOP(800_000))
  })
})

describe("Stacked100", () => {
  it("segmentos en el orden recibido con --data-1..5 y leyenda con % siempre visible", () => {
    const partes = [
      { key: "ef", etiqueta: "Efectivo", share_bp: 4500, valor: "$ 900.000" },
      { key: "ta", etiqueta: "Tarjeta", share_bp: 3000 },
      { key: "ne", etiqueta: "Nequi", share_bp: 1500 },
      { key: "da", etiqueta: "Daviplata", share_bp: 500 },
      { key: "tr", etiqueta: "Transferencia", share_bp: 300 },
      { key: "bo", etiqueta: "Bono", share_bp: 150 },
      { key: "ot", etiqueta: "Otro", share_bp: 50 },
    ]
    const { container } = render(<Stacked100 partes={partes} />)
    const seg = Array.from(container.querySelectorAll<HTMLElement>("[data-segmento]"))
    expect(seg.map((s) => s.dataset.segmento)).toEqual(["ef", "ta", "ne", "da", "tr", "bo", "ot"])
    expect(seg[0]!.style.background).toBe("var(--data-1)")
    expect(seg[4]!.style.background).toBe("var(--data-5)")
    // Del sexto en adelante: gris, cada una su segmento (no se suman).
    expect(seg[5]!.style.background).toBe("var(--data-muted)")
    expect(seg[6]!.style.background).toBe("var(--data-muted)")
    expect(screen.getByText(/^45,0\s%$/)).toBeInTheDocument()
    expect(screen.getByText(/^0,5\s%$/)).toBeInTheDocument()
    expect(screen.getByText("$ 900.000")).toBeInTheDocument()
    expect(screen.getByRole("img")).toHaveAccessibleName(new RegExp(`Efectivo ${formatPct(4500)}`))
  })
})

describe("DivergingBars", () => {
  const datos = [
    { key: "t1", etiqueta: "Turno 1", valor: -18_000 },
    { key: "t2", etiqueta: "Turno 2", valor: 5_000 },
    { key: "t3", etiqueta: "Turno 3", valor: null },
    { key: "t4", etiqueta: "Turno 4", valor: 0 },
  ]

  it("faltante rojo con ▼ y signo; sobrante ámbar con ▲ y +; null rayado", () => {
    const { container } = render(<DivergingBars datos={datos} formato={formatCOP} />)
    const t1 = container.querySelector('[data-fila="t1"]')!
    expect(t1).toHaveTextContent("▼")
    expect(t1.querySelector("[data-cifra]")!.textContent).toMatch(/^−\$\s18\.000$/)
    expect(t1).toHaveTextContent("faltante")
    expect((t1.querySelector("[data-barra]") as HTMLElement).style.background).toBe("var(--diverge-falta)")

    const t2 = container.querySelector('[data-fila="t2"]')!
    expect(t2).toHaveTextContent("▲")
    expect(t2.querySelector("[data-cifra]")!.textContent).toMatch(/^\+\$\s5\.000$/)
    expect(t2).toHaveTextContent("sobrante")
    expect((t2.querySelector("[data-barra]") as HTMLElement).style.background).toBe("var(--diverge-sobra)")

    expect(container.querySelector('[data-hueco="t3"]')).not.toBeNull()
    expect(container.querySelector('[data-fila="t3"]')).toHaveTextContent("sin dato")
    expect(container.querySelector('[data-fila="t4"]')).toHaveTextContent("cuadra")
    expect(container.querySelector('[data-fila="t4"] [data-barra]')).toBeNull()
  })

  it("faltaCuando positivo invierte color y flecha, no el signo de la cifra", () => {
    // La flecha dice faltante (▼) o sobrante (▲) en todo el sistema, igual
    // que `Diferencia`; el signo de la cifra es el del servidor.
    const { container } = render(<DivergingBars datos={datos} formato={formatCOP} faltaCuando="positivo" />)
    const t2 = container.querySelector('[data-fila="t2"]')!
    expect(t2).toHaveTextContent("▼")
    expect(t2.querySelector("[data-cifra]")!.textContent).toMatch(/5\.000$/)
    expect(t2.querySelector("[data-cifra]")!.textContent).not.toMatch(/^−/)
    expect(t2).toHaveTextContent("faltante")
    expect((t2.querySelector("[data-barra]") as HTMLElement).style.background).toBe("var(--diverge-falta)")
  })

  it("no reordena", () => {
    const { container } = render(<DivergingBars datos={datos} formato={formatCOP} />)
    const orden = Array.from(container.querySelectorAll("[data-fila]")).map((e) => e.getAttribute("data-fila"))
    expect(orden).toEqual(["t1", "t2", "t3", "t4"])
  })
})

describe("Pareto", () => {
  it("barras en el orden del acumulado, la línea de acumulado y la guía del 80 %", () => {
    const datos = [
      { key: "b", etiqueta: "Papa", valor: 40_000, acumulado_bp: 8000 },
      { key: "a", etiqueta: "Pechuga", valor: 100_000, acumulado_bp: 5714 },
      { key: "c", etiqueta: "Sal", valor: 35_000, acumulado_bp: 10000 },
    ]
    const { container } = render(<Pareto datos={datos} formato={formatCOP} />)
    const orden = Array.from(container.querySelectorAll("[data-columna]")).map((e) => e.getAttribute("data-columna"))
    expect(orden).toEqual(["a", "b", "c"])
    expect(container.querySelector("[data-acumulado] polyline")).not.toBeNull()
    expect(container.querySelector("[data-guia80]")).toHaveTextContent("80 %")
    expect(screen.getByRole("img")).toHaveAccessibleName(/los primeros 2 llegan al 80/)
  })
})

describe("QuadrantScatter", () => {
  const puntos = [
    { key: "p1", etiqueta: "Bandeja paisa", x: 900, y: 18_000, resaltar: true },
    { key: "p2", etiqueta: "Sopa de guineo", x: 120, y: 6_000 },
    { key: "p3", etiqueta: "Limonada", x: 700, y: 3_000 },
    { key: "p4", etiqueta: "Churrasco", x: 200, y: 22_000 },
  ]
  const props = {
    puntos,
    umbralX: { valor: 333, etiqueta: "Popularidad 3,33 %" },
    umbralY: { valor: 12_436, etiqueta: "Margen prom. $ 12.436" },
    ejeX: { titulo: "Popularidad", formato: (v: number) => formatPct(v, 0) },
    ejeY: { titulo: "Margen por unidad", formato: formatCOP },
    cuadrantes: ["Estrella", "Enigma", "Perro", "Caballo"] as [string, string, string, string],
  }

  it("una sola tinta, umbrales rotulados, cuadrantes y rótulo del resaltado", () => {
    const { container } = render(<QuadrantScatter {...props} />)
    const fills = new Set(Array.from(container.querySelectorAll("[data-punto]")).map((c) => c.getAttribute("fill")))
    expect([...fills]).toEqual(["var(--data-ink)"])
    expect(container.querySelector('[data-umbral="x"]')).toHaveTextContent("Popularidad 3,33 %")
    expect(container.querySelector('[data-umbral="y"]')).toHaveTextContent("Margen prom. $ 12.436")
    expect(container.querySelector("[data-cuadrantes]")).toHaveTextContent(/Estrella.*Enigma.*Perro.*Caballo/)
    expect(container.querySelector('[data-rotulo="p1"]')).not.toBeNull()
    expect(screen.getByRole("img")).toHaveAccessibleName(/Estrella: 1; Enigma: 1; Perro: 1; Caballo: 1/)
  })

  it("blanco de 24 px por punto con globo", () => {
    const { container } = render(<QuadrantScatter {...props} />)
    const blancos = container.querySelectorAll('circle[fill="transparent"]')
    expect(blancos).toHaveLength(4)
    expect(Number(blancos[0]!.getAttribute("r")) * 2).toBeGreaterThanOrEqual(24)
    fireEvent.pointerEnter(blancos[1]!)
    expect(container.querySelector("[data-chart-globo]")).toHaveTextContent("Sopa de guineo")
  })
})

describe("ThresholdDots", () => {
  it("sobre el umbral: triángulo rojo con ▲; null como hueco", () => {
    const puntos = [
      { key: "w1", etiqueta: "V1", valor: 300 },
      { key: "w2", etiqueta: "V2", valor: 900 },
      { key: "w3", etiqueta: "V3", valor: null },
      { key: "w4", etiqueta: "V4", valor: 800 },
    ]
    const { container } = render(
      <ThresholdDots puntos={puntos} umbral={{ valor: 500, etiqueta: "Umbral rojo" }} formato={(v) => formatPct(v)} />,
    )
    expect(container.querySelector('[data-punto="w2"]')).toHaveAttribute("fill", "var(--diverge-falta)")
    expect(container.querySelector('[data-punto="w2"]')).toHaveAttribute("data-sobre")
    expect(container.querySelector('[data-punto="w1"]')).toHaveAttribute("fill", "var(--data-ink)")
    expect(container.querySelector('[data-hueco="w3"]')).not.toBeNull()
    expect(container.querySelector('[data-punto="w3"]')).toBeNull()
    expect(container.querySelector("[data-umbral]")).toHaveTextContent(/Umbral rojo: 5,0\s%/)
    expect(container.textContent).toContain(`▲ 8,0${FINO}%`)
    expect(screen.getByRole("img")).toHaveAccessibleName(/2 por encima, 1 sin dato/)
  })
})

describe("Medidor", () => {
  it("escala el ancho hacia la meta y muestra el avance que manda el backend", () => {
    const { container } = render(
      <Medidor
        valor={5_000_000}
        meta={8_000_000}
        formato={formatCOP}
        etiquetaValor="Vendido en el mes"
        etiquetaMeta="Punto de equilibrio"
        avance="62,5 %"
      />,
    )
    expect((container.querySelector("[data-relleno]") as HTMLElement).style.width).toBe("62.5%")
    expect(screen.getByText("(62,5 %)")).toBeInTheDocument()
    expect(screen.getByText(formatCOP(8_000_000))).toBeInTheDocument()
  })

  it("pasada la meta, la barra llena y la meta queda marcada donde cae", () => {
    const { container } = render(
      <Medidor valor={10} meta={8} formato={String} etiquetaValor="v" etiquetaMeta="m" />,
    )
    expect((container.querySelector("[data-relleno]") as HTMLElement).style.width).toBe("100%")
    expect((container.querySelector("[data-meta]") as HTMLElement).style.left).toBe("80%")
  })
})
