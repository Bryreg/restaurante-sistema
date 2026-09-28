/**
 * La tabla densa del handoff (`docs/diseno/handoff-pos-y-panel`, pantalla 12 ·
 * `AdminTabla.dc.html`): «?» por encabezado que abre una fila `accent`, la
 * ranura del mini gráfico de 90 × 10, el «⋯» de 230 px con «Nada se borra»,
 * las píldoras de filtro y el estado con forma y palabra.
 */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

import {
  DENSE_BULLET_SIZE,
  DenseTable,
  DenseTableBar,
  DenseTableSearch,
  FilterPill,
  NADA_SE_BORRA,
  RowStatusLabel,
  type DenseColumn,
} from "@/components/admin/DenseTable"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"

interface Insumo {
  id: number
  nombre: string
  stock: string
  area: string
}

const FILAS: Insumo[] = [
  { id: 1, nombre: "Pechuga de pollo", stock: "−2,4 kg", area: "Cocina" },
  { id: 2, nombre: "Aceite", stock: "2,1 gal.", area: "Cocina" },
]

const COLUMNAS: DenseColumn<Insumo>[] = [
  { key: "nombre", header: "Insumo", kind: "name", cell: (i) => i.nombre },
  {
    key: "stock",
    header: "Stock",
    kind: "number",
    help: "Lo que dice el sistema ahora.",
    cell: (i) => i.stock,
    bullet: (i) => <span data-testid={`bullet-${i.id}`}>bullet</span>,
  },
  { key: "estado", header: "Estado", help: "Negativo no es lo mismo que bajo mínimo.", cell: () => "Negativo" },
  { key: "area", header: "Área", secondary: true, help: "Dónde se cuenta.", cell: (i) => i.area },
]

function tabla(extra: Partial<Parameters<typeof DenseTable<Insumo>>[0]> = {}) {
  return render(
    <MemoryRouter>
      <DenseTable
        caption="Stock"
        rows={FILAS}
        rowKey={(i) => String(i.id)}
        rowLabel={(i) => i.nombre}
        columns={COLUMNAS}
        {...extra}
      />
    </MemoryRouter>,
  )
}

describe("«?» por encabezado: la explicación a un toque, no en cada fila", () => {
  it("abre una fila con el nombre de la columna y su explicación, y se cierra con el mismo «?»", async () => {
    const user = userEvent.setup()
    tabla()

    const ayuda = screen.getByRole("button", { name: "¿Qué es Estado?" })
    expect(ayuda).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText(/no es lo mismo que bajo mínimo/)).toBeNull()

    await user.click(ayuda)
    expect(ayuda).toHaveAttribute("aria-expanded", "true")
    const fila = screen.getByText(/no es lo mismo que bajo mínimo/).closest("td") as HTMLTableCellElement
    expect(fila).toHaveTextContent("Estado: Negativo no es lo mismo que bajo mínimo.")
    // A todo el ancho: columnas visibles + la de acciones si la hay.
    expect(fila.colSpan).toBe(3)
    expect(fila.className).toContain("bg-accent")

    await user.click(ayuda)
    expect(screen.queryByText(/no es lo mismo que bajo mínimo/)).toBeNull()
  })

  it("una sola abierta a la vez: abrir otra cierra la anterior", async () => {
    const user = userEvent.setup()
    tabla()
    await user.click(screen.getByRole("button", { name: "¿Qué es Estado?" }))
    await user.click(screen.getByRole("button", { name: "¿Qué es Stock?" }))
    expect(screen.getByText(/Lo que dice el sistema ahora/)).toBeInTheDocument()
    expect(screen.queryByText(/no es lo mismo que bajo mínimo/)).toBeNull()
  })

  it("una columna sin ayuda no lleva «?», y la de «Más columnas» lo trae al abrirse", async () => {
    const user = userEvent.setup()
    tabla()
    expect(screen.queryByRole("button", { name: "¿Qué es Insumo?" })).toBeNull()
    expect(screen.queryByRole("button", { name: "¿Qué es Área?" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Más columnas (1)" }))
    expect(screen.getByRole("button", { name: "¿Qué es Área?" })).toBeInTheDocument()
  })
})

describe("la ranura del mini gráfico (bullet)", () => {
  it("reserva 90 × 10 px a la derecha de la cifra y pinta lo que manda la columna", () => {
    tabla()
    const fila = screen.getByRole("row", { name: /Pechuga de pollo/ })
    const bullet = within(fila).getByTestId("bullet-1")
    const ranura = bullet.parentElement as HTMLElement
    expect(ranura.dataset.slot).toBe("bullet")
    expect(ranura.style.width).toBe(`${DENSE_BULLET_SIZE.width}px`)
    expect(ranura.style.height).toBe(`${DENSE_BULLET_SIZE.height}px`)
    // La cifra sigue en la celda, antes del gráfico.
    expect(within(fila).getByText("−2,4 kg")).toBeInTheDocument()
  })

  it("sin `bullet` la celda es la de siempre: no hay ranura vacía", () => {
    tabla({ columns: COLUMNAS.map(({ bullet: _b, ...c }) => c) })
    expect(document.querySelector('[data-slot="bullet"]')).toBeNull()
  })
})

describe("«⋯» por fila: acciones con nombre y la nota «Nada se borra»", () => {
  it("cada fila lleva su botón nombrado, y el menú trae los ítems y la nota al pie", async () => {
    const user = userEvent.setup()
    const ajustar = vi.fn()
    tabla({
      rowMenu: (i) => <DropdownMenuItem onClick={() => ajustar(i.id)}>Ajustar con motivo</DropdownMenuItem>,
    })

    const boton = screen.getByRole("button", { name: "Acciones de Aceite" })
    await user.click(boton)
    const menu = await screen.findByRole("menu")
    expect(within(menu).getByText(NADA_SE_BORRA)).toBeInTheDocument()
    expect(menu.className).toContain("w-[230px]")
    await user.click(within(menu).getByRole("menuitem", { name: "Ajustar con motivo" }))
    expect(ajustar).toHaveBeenCalledWith(2)
  })

  it("la nota se puede decir con las palabras de la pantalla", async () => {
    const user = userEvent.setup()
    tabla({
      rowMenu: () => <DropdownMenuItem>Ver ficha</DropdownMenuItem>,
      rowMenuNote: "Nada se borra: los ajustes quedan en el libro con motivo.",
    })
    await user.click(screen.getByRole("button", { name: "Acciones de Pechuga de pollo" }))
    expect(await screen.findByText("Nada se borra: los ajustes quedan en el libro con motivo.")).toBeInTheDocument()
  })
})

describe("la barra: píldoras, buscador y recuento", () => {
  it("la píldora dice si está puesta (aria-pressed), no sólo con el color", async () => {
    const user = userEvent.setup()
    const tocar = vi.fn()
    render(
      <DenseTableBar shown={9} total={47} noun="insumos">
        <FilterPill pressed onClick={() => {}}>
          Todos
        </FilterPill>
        <FilterPill pressed={false} onClick={tocar}>
          Negativos
        </FilterPill>
      </DenseTableBar>,
    )
    expect(screen.getByRole("button", { name: "Todos" })).toHaveAttribute("aria-pressed", "true")
    const negativos = screen.getByRole("button", { name: "Negativos" })
    expect(negativos).toHaveAttribute("aria-pressed", "false")
    await user.click(negativos)
    expect(tocar).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/de/, { selector: "p" }).textContent).toBe("9 de 47 insumos")
  })

  it("el buscador se nombra con lo que dice", async () => {
    const user = userEvent.setup()
    const cambiar = vi.fn()
    render(<DenseTableSearch value="" onChange={cambiar} placeholder="Buscar insumo" />)
    await user.type(screen.getByRole("searchbox", { name: "Buscar insumo" }), "a")
    expect(cambiar).toHaveBeenCalledWith("a")
  })
})

describe("el estado con forma y palabra: nunca sólo color", () => {
  it.each([
    ["critical", "semaforo-red", "text-destructive"],
    ["warning", "semaforo-amber", "text-warning"],
    ["ok", "semaforo-green", "text-success"],
  ] as const)("%s lleva su forma (%s) y su tinta", (status, forma, tinta) => {
    render(<RowStatusLabel status={status}>Palabra</RowStatusLabel>)
    const etiqueta = screen.getByText("Palabra")
    expect(etiqueta.className).toContain(tinta)
    expect(etiqueta.querySelector(".semaforo")?.className).toContain(forma)
  })
})

describe("«Cómo leer esta tabla» sigue plegada, ahora con su chevrón", () => {
  it("la leyenda está en un <details> cerrado", () => {
    tabla({ legend: [{ term: "Sin costo", meaning: "no es $ 0." }] })
    const resumen = screen.getByText("Cómo leer esta tabla")
    expect(resumen.tagName).toBe("SUMMARY")
    expect((resumen.closest("details") as HTMLDetailsElement).open).toBe(false)
  })
})
