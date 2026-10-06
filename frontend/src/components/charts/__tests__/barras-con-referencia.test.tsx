import { render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import {
  BarrasConReferencia,
  BulletReferencia,
  DivergingBars,
  HorarioGantt,
  QuadrantScatter,
  estaFuera,
  etiquetaHora,
  minutosBogota,
  type PuntoReferencia,
} from "@/components/charts"
import { formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"

const LEYENDA_VENTAS = {
  barra: "Esta semana",
  raya: "El mismo día de la semana anterior",
  fuera: "Por debajo de la semana anterior",
}

const DIAS: PuntoReferencia[] = [
  { key: "sab", etiqueta: "sáb 20", valor: 17_900_000, referencia: 17_000_000, cifra: "+5 %", detalle: "17,9 M" },
  { key: "dom", etiqueta: "dom 21", valor: 11_000_000, referencia: 12_000_000, cifra: "−8 %", detalle: "11,0 M" },
  { key: "lun", etiqueta: "lun 22", valor: null, referencia: 7_000_000 },
  { key: "mar", etiqueta: "mar 23", valor: 8_100_000, referencia: 8_000_000, futuro: true },
  { key: "mie", etiqueta: "mié 24", valor: 9_100_000, referencia: 8_400_000, ahora: true, href: "/admin/ventas?dia=24" },
]

function renderRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

function barra(container: HTMLElement, i: number): HTMLElement {
  const barras = container.querySelectorAll<HTMLElement>('[data-slot="columnas"] > *')
  return barras[i]!.querySelector<HTMLElement>("[data-barra]")!
}

describe("estaFuera", () => {
  it("compara con la raya según el lado malo, y lo del backend manda", () => {
    expect(estaFuera(9, 10, "debajo")).toBe(true)
    expect(estaFuera(11, 10, "debajo")).toBe(false)
    expect(estaFuera(11, 10, "encima")).toBe(true)
    expect(estaFuera(10, 10, "encima")).toBe(false)
    expect(estaFuera(null, 10, "debajo")).toBe(false)
    expect(estaFuera(9, null, "debajo")).toBe(false)
    expect(estaFuera(11, 10, "debajo", true)).toBe(true)
  })
})

describe("BarrasConReferencia — columnas", () => {
  it("la pregunta es el título y la leyenda va arriba con cuadro, ámbar y raya", () => {
    const { container } = renderRouter(
      <BarrasConReferencia
        pregunta="¿Vendí más o menos que la semana pasada?"
        puntos={DIAS}
        malo="debajo"
        leyenda={LEYENDA_VENTAS}
        formato={formatCOP}
        flechas
      />,
    )
    expect(screen.getByRole("heading", { name: "¿Vendí más o menos que la semana pasada?" })).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "¿Vendí más o menos que la semana pasada?" })).toBeInTheDocument()
    const leyenda = container.querySelector('[data-slot="leyenda"]')!
    expect(leyenda).toHaveTextContent("Esta semana")
    expect(leyenda).toHaveTextContent("Por debajo de la semana anterior")
    expect(leyenda).toHaveTextContent("El mismo día de la semana anterior")
    expect(leyenda.querySelector(".bg-warning")).not.toBeNull()
  })

  it("del lado malo la barra va en ámbar y su cifra también, con ▼ y texto — nunca sólo color", () => {
    const { container } = renderRouter(
      <BarrasConReferencia pregunta="Ventas" puntos={DIAS} malo="debajo" leyenda={LEYENDA_VENTAS} formato={formatCOP} flechas />,
    )
    const domingo = barra(container, 1)
    expect(domingo).toHaveAttribute("data-fuera")
    expect(domingo.className).toContain("bg-warning")
    const cifra = container.querySelectorAll('[data-slot="columnas"] [data-cifra]')[1]!
    expect(cifra.className).toContain("text-warning")
    expect(cifra.textContent).toBe("▼ −8 %")
    // El texto accesible dice que quedó fuera, con palabras.
    const lista = container.querySelector("ul.sr-only")!
    expect(lista).toHaveTextContent(/dom 21: .*Por debajo de la semana anterior/)
    expect(lista).toHaveTextContent("1 de 5: por debajo de la semana anterior.")

    const sabado = barra(container, 0)
    expect(sabado).not.toHaveAttribute("data-fuera")
    expect(sabado.className).toContain("bg-(--data-1)")
    expect(container.querySelectorAll('[data-slot="columnas"] [data-cifra]')[0]!.textContent).toBe("▲ +5 %")
  })

  it("la raya sale de su referencia (3 px, sobresale a los lados) y la barra se escala al tope", () => {
    const { container } = renderRouter(
      <BarrasConReferencia pregunta="Ventas" puntos={DIAS} malo="debajo" leyenda={LEYENDA_VENTAS} formato={formatCOP} />,
    )
    const primera = container.querySelector('[data-slot="columnas"] > *')!
    const raya = primera.querySelector<HTMLElement>("[data-raya]")!
    expect(raya.className).toContain("h-[3px]")
    expect(raya.className).toContain("-inset-x-1")
    expect(raya.className).toContain("bg-foreground")
    // Tope = 17,9 M: la raya de 17 M queda al 94,97 %.
    expect(Number.parseFloat(raya.style.bottom)).toBeCloseTo((17_000_000 / 17_900_000) * 100, 3)
    expect(barra(container, 0).style.height).toBe("100%")
    expect(barra(container, 0).className).toContain("rounded-t-[3px]")
  })

  it("lo que viene va al 35 % y «ahora» en tinta de texto", () => {
    const { container } = renderRouter(
      <BarrasConReferencia pregunta="Ventas" puntos={DIAS} malo="debajo" leyenda={LEYENDA_VENTAS} formato={formatCOP} />,
    )
    const futuro = barra(container, 3)
    expect(futuro).toHaveAttribute("data-futuro")
    expect(futuro.className).toContain("opacity-35")
    const ahora = barra(container, 4)
    expect(ahora).toHaveAttribute("data-ahora")
    expect(ahora.className).toContain("bg-foreground")
    expect(ahora.className).not.toContain("opacity-35")
  })

  it("«ahora» del lado malo conserva el ámbar y suma el anillo de 2 px", () => {
    const { container } = renderRouter(
      <BarrasConReferencia
        pregunta="Personas"
        puntos={[{ etiqueta: "12", valor: 3, referencia: 5, ahora: true }]}
        malo="debajo"
        leyenda={{ barra: "Personas", raya: "Programado", fuera: "Faltan" }}
        formato={String}
      />,
    )
    const b = barra(container, 0)
    expect(b.className).toContain("bg-warning")
    expect(b.className).toContain("ring-2")
  })

  it("un null es un hueco (marca apagada al pie, sin trama) que se lee «sin dato», nunca una barra de 0", () => {
    const { container } = renderRouter(
      <BarrasConReferencia pregunta="Ventas" puntos={DIAS} malo="debajo" leyenda={LEYENDA_VENTAS} formato={formatCOP} />,
    )
    const lunes = container.querySelectorAll('[data-slot="columnas"] > *')[2]!
    expect(lunes.querySelector("[data-hueco]")).not.toBeNull()
    expect(lunes.querySelector("[data-barra]")).toBeNull()
    // Pulido del panel: el hueco ya no llena la columna con trama.
    expect(lunes.querySelector("[data-hueco]")!.className).not.toContain("sin-dato")
    expect(lunes.querySelector("[data-hueco]")!.className).not.toContain("h-full")
    expect(container.querySelector("ul.sr-only")).toHaveTextContent("lun 22: sin dato")
  })

  it("la barra enlaza a su detalle con la cifra exacta en el nombre y el title", () => {
    renderRouter(
      <BarrasConReferencia pregunta="Ventas" puntos={DIAS} malo="debajo" leyenda={LEYENDA_VENTAS} formato={formatCOP} />,
    )
    const link = screen.getByRole("link", { name: /mié 24: \$\s9\.100\.000/ })
    expect(link).toHaveAttribute("href", "/admin/ventas?dia=24")
    expect(link.getAttribute("title")).toMatch(/El mismo día de la semana anterior: \$\s8\.400\.000/)
  })

  it("cocina y mesas usan rojo con ▲ cuando pasan el límite", () => {
    const { container } = renderRouter(
      <BarrasConReferencia
        pregunta="Minutos de cada tiquete"
        puntos={[
          { etiqueta: "M11", valor: 26 },
          { etiqueta: "M6", valor: 12 },
        ]}
        referenciaComun={20}
        malo="encima"
        tono="destructive"
        leyenda={{ barra: "Minutos", raya: "Límite 20 min", fuera: "Pasó el límite" }}
        formato={(v) => `${v} min`}
      />,
    )
    const pasado = barra(container, 0)
    expect(pasado.className).toContain("bg-destructive")
    const cifra = container.querySelector('[data-slot="columnas"] [data-cifra]')!
    expect(cifra.className).toContain("text-destructive")
    expect(cifra.textContent).toBe("▲ 26 min")
    expect(barra(container, 1).className).toContain("bg-(--data-1)")
    // La raya común se dibuja en cada columna.
    expect(container.querySelectorAll("[data-raya]")).toHaveLength(2)
  })

  it("lo que decidió el backend (`fuera`) manda sobre la comparación", () => {
    const { container } = renderRouter(
      <BarrasConReferencia
        pregunta="Efectivo"
        puntos={[{ etiqueta: "9 a. m.", valor: 1_200_000, referencia: 1_200_000, fuera: true }]}
        malo="encima"
        leyenda={{ barra: "Efectivo", raya: "Umbral", fuera: "Pide retiro" }}
        formato={formatCOP}
      />,
    )
    expect(barra(container, 0)).toHaveAttribute("data-fuera")
  })

  it("la fila extra lleva la cantidad de meseros bajo cada hora", () => {
    const { container } = renderRouter(
      <BarrasConReferencia
        pregunta="¿A qué horas falta gente en el salón?"
        puntos={[
          { etiqueta: "12 p. m.", valor: 52, referencia: 42, extra: "6" },
          { etiqueta: "1 p. m.", valor: 30, referencia: 42, extra: "6" },
        ]}
        malo="encima"
        leyenda={{ barra: "Comandas por hora", raya: "Lo que alcanzan los meseros", fuera: "Pasan lo que el salón alcanza" }}
        formato={String}
        unidadExtra="meseros"
      />,
    )
    const extra = container.querySelector('[data-slot="fila-extra"]')!
    expect(extra).toHaveTextContent("6meseros6meseros")
  })

  it("el resumen lateral de 280 px lleva rótulo, franja de color y título con detalle", () => {
    const { container } = renderRouter(
      <BarrasConReferencia
        pregunta="Ventas"
        puntos={DIAS}
        malo="debajo"
        leyenda={LEYENDA_VENTAS}
        formato={formatCOP}
        rotuloResumen="La semana en una línea"
        resumen={[
          { titulo: "7 de 7 días por encima", detalle: "La semana cerró ▲ +4,1 %.", tono: "success" },
          { titulo: "El mejor: mié 24", detalle: "El que más creció.", tono: "data" },
        ]}
      />,
    )
    const aside = container.querySelector<HTMLElement>('[data-slot="resumen"]')!
    expect(aside.className).toContain("md:w-[280px]")
    expect(aside.className).toContain("md:border-l")
    expect(aside).toHaveTextContent("La semana en una línea")
    expect(within(aside).getByText("7 de 7 días por encima").tagName).toBe("B")
    expect(aside.querySelector('[data-tono="success"] .bg-success')).not.toBeNull()
    expect(aside.querySelector('[data-tono="data"] .bg-\\(--data-1\\)')).not.toBeNull()
  })
})

describe("BarrasConReferencia — filas", () => {
  const MARGEN: PuntoReferencia[] = [
    { etiqueta: "Bebidas", valor: 7_900, cifra: formatPct(7_900, 0), detalle: "▲ +1 pts" },
    { etiqueta: "Platos fuertes", valor: 5_700, cifra: formatPct(5_700, 0), detalle: "8 pts bajo la meta" },
  ]

  it("la barra crece a lo ancho, la raya es vertical y lo de abajo de la meta va en ámbar con ▼", () => {
    const { container } = renderRouter(
      <BarrasConReferencia
        variante="filas"
        pregunta="¿Qué categoría deja menos plata?"
        puntos={MARGEN}
        referenciaComun={6_500}
        maximo={10_000}
        malo="debajo"
        leyenda={{ barra: "Margen de la categoría", raya: "Meta: 65 %", fuera: "Bajo la meta" }}
        formato={(v) => formatPct(v, 0)}
      />,
    )
    const filas = container.querySelectorAll<HTMLElement>('[data-slot="filas"] > *')
    expect(filas).toHaveLength(2)
    const bebidas = filas[0]!.querySelector<HTMLElement>("[data-barra]")!
    expect(bebidas.style.width).toBe("79%")
    expect(bebidas.className).toContain("bg-(--data-1)")
    const raya = filas[0]!.querySelector<HTMLElement>("[data-raya]")!
    expect(raya.style.left).toBe("65%")
    expect(raya.className).toContain("w-[3px]")

    const fuertes = filas[1]!.querySelector<HTMLElement>("[data-barra]")!
    expect(fuertes.className).toContain("bg-warning")
    const cifra = filas[1]!.querySelector("[data-cifra]")!
    expect(cifra.className).toContain("text-warning")
    expect(cifra.textContent).toMatch(/^▼ 57/)
    expect(filas[1]).toHaveTextContent("8 pts bajo la meta")
    // La leyenda de filas dibuja la raya vertical.
    expect(container.querySelector('[data-slot="leyenda"] .w-\\[3px\\]')).not.toBeNull()
  })
})

describe("BulletReferencia", () => {
  it("es de 90 × 10 con la raya vertical y un texto accesible completo", () => {
    renderRouter(
      <BulletReferencia
        etiqueta="Efectivo en caja"
        valor={1_412_000}
        referencia={1_200_000}
        malo="encima"
        formato={formatCOP}
        nombreRaya="umbral de retiro"
        textoFuera="pasa el umbral"
      />,
    )
    const img = screen.getByRole("img", { name: /Efectivo en caja: \$\s1\.412\.000 · umbral de retiro: \$\s1\.200\.000 · ▲ pasa el umbral/ })
    expect(img.style.width).toBe("90px")
    expect(img.className).toContain("h-2.5")
    expect(img).toHaveAttribute("data-fuera")
    expect(img.querySelector("[data-barra]")!.className).toContain("bg-warning")
    const raya = img.querySelector<HTMLElement>("[data-raya]")!
    expect(raya.className).toContain("-inset-y-[3px]")
    expect(Number.parseFloat(raya.style.left)).toBeCloseTo((1_200_000 / 1_412_000) * 100, 3)
  })

  it("con tope (mínimo × 2,5) y del lado bueno va en azul; sin dato, rayado", () => {
    const { rerender } = renderRouter(
      <BulletReferencia etiqueta="Stock" valor={12} referencia={5} maximo={12.5} malo="debajo" formato={String} />,
    )
    const img = screen.getByRole("img")
    expect(img).not.toHaveAttribute("data-fuera")
    expect(img.querySelector<HTMLElement>("[data-barra]")!.style.width).toBe("96%")
    expect(img.querySelector<HTMLElement>("[data-raya]")!.style.left).toBe("40%")
    expect(img.querySelector("[data-barra]")!.className).toContain("bg-(--data-1)")

    rerender(
      <MemoryRouter>
        <BulletReferencia etiqueta="Stock" valor={null} referencia={5} malo="debajo" formato={String} />
      </MemoryRouter>,
    )
    expect(screen.getByRole("img", { name: /Stock: sin dato/ }).querySelector("[data-hueco]")).not.toBeNull()
  })

  it("en rojo para límites de tiempo y a lo ancho en los bloques de Hoy", () => {
    renderRouter(
      <BulletReferencia etiqueta="Mesa 3" valor={75} referencia={60} malo="encima" tono="destructive" ancho="completo" formato={(v) => `${v} min`} />,
    )
    const img = screen.getByRole("img")
    expect(img.className).toContain("w-full")
    expect(img.querySelector("[data-barra]")!.className).toContain("bg-destructive")
  })
})

describe("HorarioGantt", () => {
  const FILAS = [
    {
      key: "kevin",
      etiqueta: "Kevin Ruiz",
      detalle: "Caja",
      tramos: [{ entrada: "2026-09-19T12:00:00Z", salida: "2026-09-19T21:00:00Z" }],
    },
    {
      key: "camilo",
      etiqueta: "Camilo Rojas",
      tramos: [{ entrada: "2026-09-19T20:00:00Z", salida: null }],
      href: "/admin/equipo/personas/2",
    },
  ]

  it("una fila de 30 px por persona, la barra de entrada a salida en la hora de Bogotá", () => {
    const { container } = renderRouter(
      <HorarioGantt filas={FILAS} ahora="2026-09-20T01:00:00Z" relevos={[{ hora: "2026-09-19T20:00:00Z", etiqueta: "Relevo" }]} />,
    )
    expect(minutosBogota("2026-09-19T12:00:00Z")).toBe(7 * 60)
    const filas = container.querySelectorAll("[data-fila]")
    expect(filas).toHaveLength(2)
    const pista = filas[0]!.querySelector<HTMLElement>(".h-\\[30px\\]")!
    expect(pista).not.toBeNull()
    const tramo = filas[0]!.querySelector<HTMLElement>("[data-tramo]")!
    // 7 a. m. a 4 p. m. sobre un eje de 6 a. m. a 12 a. m. (18 h).
    expect(Number.parseFloat(tramo.style.left)).toBeCloseTo((1 / 18) * 100, 3)
    expect(Number.parseFloat(tramo.style.width)).toBeCloseTo((9 / 18) * 100, 3)
    expect(tramo.className).toContain("bg-(--data-1)")
    // Tramo abierto: llega hasta «ahora» (8 p. m.).
    const abierto = filas[1]!.querySelector<HTMLElement>("[data-tramo]")!
    expect(abierto).toHaveAttribute("data-abierto")
    expect(Number.parseFloat(abierto.style.width)).toBeCloseTo((5 / 18) * 100, 3)
    // El relevo: línea vertical punteada de 2 px en cada fila.
    const relevo = filas[0]!.querySelector<HTMLElement>("[data-relevo]")!
    expect(relevo.className).toContain("border-l-2")
    expect(relevo.className).toContain("border-dashed")
    // Accesible: la fila se lee con horas, y la que enlaza es un link.
    expect(screen.getByText(/Kevin Ruiz · entrada 7:00 a\.\s?m\..*salida 4:00 p\.\s?m\./)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Camilo Rojas · entrada 3:00 p\.\s?m\., salida sigue adentro/ })).toHaveAttribute(
      "href",
      "/admin/equipo/personas/2",
    )
    // Marcas cada hora: 19 líneas (6 a. m. … 12 a. m.).
    expect(pista.querySelectorAll(".w-px")).toHaveLength(19)
    expect(etiquetaHora(24)).toBe("12 a. m.")
    expect(etiquetaHora(6)).toBe("6 a. m.")
  })
})

describe("QuadrantScatter — variante mix («Mix de platos»)", () => {
  const PLATOS = [
    { key: "limonada", etiqueta: "Limonada de coco", x: 690, y: 8_100, detalle: "81 %" },
    { key: "mojarra", etiqueta: "Mojarra frita", x: 176, y: 5_700, detalle: "57 %", alerta: true },
    { key: "bandeja", etiqueta: "Bandeja paisa", x: 412, y: 5_800, detalle: "58 %" },
  ]

  it("promedios punteados, «▲ Revisar» en ámbar, puntos de 14 px con nombre y margen al lado", () => {
    const { container } = render(
      <QuadrantScatter
        variante="mix"
        puntos={PLATOS}
        umbralX={{ valor: 400, etiqueta: "Promedio de unidades" }}
        umbralY={{ valor: 6_500, etiqueta: "Margen promedio" }}
        ejeX={{ titulo: "Unidades vendidas", formato: String }}
        ejeY={{ titulo: "Margen", formato: (v) => formatPct(v, 0) }}
        cuadrantes={["Venden y dejan", "Dejan, pero venden poco", "Revisar", "Venden, pero dejan poco"]}
        cuadranteAlerta={2}
        rotuloResumen="Qué hacer con cada grupo"
        resumenLateral={[{ titulo: "▲ Revisar", detalle: "Mojarra frita. Vende poco y deja poco.", tono: "warning" }]}
      />,
    )
    const umbral = container.querySelector('[data-umbral="x"] line')!
    expect(umbral.getAttribute("stroke-dasharray")).toBe("1 3")
    const revisar = container.querySelector("[data-cuadrante='2']")!
    expect(revisar.textContent).toBe("▲ Revisar")
    expect(revisar.getAttribute("fill")).toBe("var(--warning)")
    expect(revisar).toHaveAttribute("data-alerta")
    // El punto a revisar va en ámbar; los otros en la tinta de datos.
    const mojarra = container.querySelector('[data-punto="mojarra"]')!
    expect(mojarra).toHaveAttribute("data-alerta")
    expect(mojarra.querySelectorAll("circle")[1]!.getAttribute("fill")).toBe("var(--warning)")
    expect(mojarra.querySelectorAll("circle")[1]!.getAttribute("r")).toBe("6")
    expect(mojarra.querySelectorAll("circle")[1]!.getAttribute("stroke")).toBe("var(--card)")
    expect(container.querySelector('[data-punto="limonada"] circle:nth-child(2)')!.getAttribute("fill")).toBe(
      "var(--data-1)",
    )
    // Nombre y margen al lado de cada punto.
    expect(container.querySelector('[data-rotulo="limonada"]')!.textContent).toBe("Limonada de coco 81 %")
    // No sólo color: el nombre del grupo a revisar está en el texto accesible.
    expect(screen.getByRole("img")).toHaveAccessibleName(/A revisar: Mojarra frita 57 %/)
    const aside = container.querySelector('[data-slot="resumen"]')!
    expect(aside).toHaveTextContent("Qué hacer con cada grupo")
    expect(aside).toHaveTextContent("Mojarra frita. Vende poco y deja poco.")
  })

  it("sin `variante` sigue siendo la forma clásica (guiones, una tinta)", () => {
    const { container } = render(
      <QuadrantScatter
        puntos={PLATOS}
        umbralX={{ valor: 400, etiqueta: "u" }}
        umbralY={{ valor: 6_500, etiqueta: "m" }}
        ejeX={{ titulo: "x", formato: String }}
        ejeY={{ titulo: "y", formato: String }}
        cuadrantes={["a", "b", "c", "d"]}
      />,
    )
    expect(container.querySelector('[data-umbral="x"] line')!.getAttribute("stroke-dasharray")).toBe("4 3")
    expect(container.querySelector('[data-punto="mojarra"]')!.getAttribute("fill")).toBe("var(--data-ink)")
    expect(container.querySelector('[data-slot="resumen"]')).toBeNull()
  })
})

describe("Extensiones para las fichas del panel", () => {
  it("la fila extra puede quedar en blanco donde no hay dato (retiros), con su propia tinta", () => {
    render(
      <MemoryRouter>
        <BarrasConReferencia
          pregunta="¿Cuándo hubo más efectivo del que debía?"
          malo="encima"
          referenciaComun={1_200_000}
          formato={formatCOP}
          leyenda={{ barra: "Efectivo", raya: "Umbral", fuera: "Por encima" }}
          extraVacio=""
          claseExtra="text-primary"
          puntos={[
            { key: "a", etiqueta: "1 p. m.", valor: 900_000, extra: "↓ $ 800.000" },
            { key: "b", etiqueta: "2 p. m.", valor: 500_000 },
          ]}
        />
      </MemoryRouter>,
    )
    const fila = document.querySelector('[data-slot="fila-extra"]')!
    const cifras = [...fila.querySelectorAll("b")]
    expect(cifras.map((b) => b.textContent)).toEqual(["↓ $ 800.000", ""])
    expect(cifras[0]!.className).toContain("text-primary")
  })

  it("DivergingBars en línea: entradas en --data-1 si se pide, salidas en --diverge-falta, cifra con signo", () => {
    render(
      <DivergingBars
        enLinea
        colorSobra="var(--data-1)"
        palabras={{ falta: "salida", sobra: "entrada", cero: "sin cambio" }}
        datos={[
          { key: "compra", etiqueta: "Compras", valor: 24 },
          { key: "venta", etiqueta: "Ventas", valor: -12.6 },
          { key: "conteo", etiqueta: "Ajuste", valor: null },
        ]}
        formato={(v) => String(v)}
      />,
    )
    const compra = document.querySelector<HTMLElement>('[data-fila="compra"] [data-barra]')!
    expect(compra.style.background).toBe("var(--data-1)")
    const venta = document.querySelector<HTMLElement>('[data-fila="venta"] [data-barra]')!
    expect(venta.style.background).toBe("var(--diverge-falta)")
    expect(screen.getByText("+24")).toBeInTheDocument()
    expect(screen.getByText("−12.6")).toBeInTheDocument()
    expect(document.querySelector('[data-hueco="conteo"]')).not.toBeNull()
  })

  it("el sobrante sigue en --diverge-sobra por defecto (caja)", () => {
    render(<DivergingBars datos={[{ key: "x", etiqueta: "Turno", valor: 2_000 }]} formato={formatCOP} />)
    expect(document.querySelector<HTMLElement>("[data-barra]")!.style.background).toBe("var(--diverge-sobra)")
  })
})

describe("BarrasConReferencia — datos flojos (pulido del panel)", () => {
  it("con `vacio` va la pregunta y una línea: ni eje, ni leyenda, ni resumen de cosas que no pasaron", () => {
    const { container } = renderRouter(
      <BarrasConReferencia
        pregunta="¿Vendí más o menos que la semana pasada?"
        puntos={DIAS.map((d) => ({ ...d, valor: 0 }))}
        malo="debajo"
        leyenda={LEYENDA_VENTAS}
        formato={formatCOP}
        vacio="Todavía no hay ventas en estos siete días."
      />,
    )
    expect(screen.getByRole("heading", { name: "¿Vendí más o menos que la semana pasada?" })).toBeInTheDocument()
    expect(screen.getByText("Todavía no hay ventas en estos siete días.")).toBeInTheDocument()
    expect(container.querySelector('[data-slot="columnas"]')).toBeNull()
    expect(container.querySelector('[data-slot="leyenda"]')).toBeNull()
  })

  it("con `cifra: \"\"` (poca base, sin variación) no se escribe ni la flecha sola", () => {
    const { container } = renderRouter(
      <BarrasConReferencia
        pregunta="Ventas"
        puntos={[{ key: "mie", etiqueta: "mié 23", valor: 0, referencia: 105_555, cifra: "" }]}
        malo="debajo"
        flechas
        leyenda={LEYENDA_VENTAS}
        formato={formatCOP}
      />,
    )
    const cifra = container.querySelector<HTMLElement>("[data-cifra]")!
    expect(cifra.textContent).toBe("")
  })

  it("con pocos puntos la columna no se estira a lo ancho del gráfico", () => {
    const { container } = renderRouter(
      <BarrasConReferencia
        pregunta="Efectivo"
        puntos={[{ key: "9", etiqueta: "9 a. m.", valor: 200_000 }]}
        malo="encima"
        leyenda={LEYENDA_VENTAS}
        formato={formatCOP}
      />,
    )
    expect(barra(container, 0).className).toContain("max-w-24")
  })
})
