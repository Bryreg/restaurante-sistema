/**
 * Las tres reglas que la ola 2 va a romper si la capa compartida se lo
 * permite. No son estilo: las tres salen de defectos medidos
 * (`docs/PATRONES-ADMIN.md`), y las tres tienen que ser difíciles de romper
 * desde el sitio de llamada, no sólo estar escritas en un comentario.
 */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

import { ConsequenceZone } from "@/components/admin/ConsequenceZone"
import { DENSE_ROW_HEIGHT_PX, DenseTable } from "@/components/admin/DenseTable"
import { FilterEmptyState } from "@/components/admin/EmptyStates"

/**
 * Las clases **incondicionales** de un elemento. `Button` trae siempre
 * `aria-invalid:border-destructive` y `focus-visible:ring-destructive/20` en
 * su base —el rojo del campo inválido, que es estado y está bien—, así que
 * buscar «destructive» a secas en el `class` no distingue un botón rojo de
 * uno que simplemente sabe dibujarse inválido. Lo que no puede existir es una
 * clase **sin variante**: ésas son las que pintan el botón siempre.
 */
function clasesSiemprePuestas(el: Element): string[] {
  return el.className.split(/\s+/).filter((c) => c.length > 0 && !c.includes(":"))
}

interface Fila {
  comanda: string
  canal: string
  total: string
}

const FILAS: Fila[] = [
  { comanda: "#1418", canal: "Mesa", total: "$ 128.400" },
  { comanda: "#1419", canal: "Domicilio", total: "$ 64.000" },
]

function tablaDePrueba() {
  return render(
    <MemoryRouter>
      <DenseTable
        caption="Comandas abiertas"
        rows={FILAS}
        rowKey={(f) => f.comanda}
        rowStatus={(f) => (f.comanda === "#1418" ? "critical" : "none")}
        columns={[
          { key: "comanda", header: "Comanda", kind: "id", cell: (f) => f.comanda },
          { key: "canal", header: "Canal", cell: (f) => f.canal },
          { key: "total", header: "Total", kind: "number", cell: (f) => f.total },
        ]}
      />
    </MemoryRouter>,
  )
}

// ───────────────────────────────────────────────────────────────────────────
// 1 · La tabla densa

describe("regla dura · la fila de la tabla densa mide 34 px y no parte palabras", () => {
  it("la fila y sus celdas miden 34 px medidos, no «más o menos»", () => {
    tablaDePrueba()
    const fila = screen.getByRole("row", { name: /#1418/ })
    expect(getComputedStyle(fila).height).toBe(`${DENSE_ROW_HEIGHT_PX}px`)
    expect(DENSE_ROW_HEIGHT_PX).toBe(34)
    for (const celda of within(fila).getAllByRole("cell")) {
      expect(getComputedStyle(celda).height).toBe("34px")
    }
  })

  it("ninguna celda de datos trae `overflow-wrap`: fue el defecto que partía «#1418» en dos líneas", () => {
    // Medido en la maqueta: el número de comanda se partía en dos líneas a
    // 1440 y en CUATRO a 1280, con la fila creciendo de 34 a 61 px. La
    // corrección no fue ensanchar la columna: fue sacar
    // `overflow-wrap:anywhere` de las celdas de datos.
    tablaDePrueba()
    for (const celda of screen.getAllByRole("cell")) {
      const estilo = getComputedStyle(celda)
      expect(estilo.overflowWrap).toBe("normal")
      expect(estilo.wordBreak).toBe("normal")
      expect(estilo.whiteSpace).toBe("nowrap")
    }
  })

  it("lo declara el `style` de la celda, no una clase: una clase de afuera lo pisaría", () => {
    // Ésta es la parte de «que el componente lo impida, no que lo pida»: un
    // estilo en línea gana contra cualquier clase que llegue desde el sitio
    // de llamada, así que la corrección no se puede volver a perder.
    tablaDePrueba()
    const celda = screen.getAllByRole("cell")[0]
    expect(celda.style.overflowWrap).toBe("normal")
    expect(celda.style.whiteSpace).toBe("nowrap")
    expect(celda.style.height).toBe("34px")
  })

  it("el número de comanda llega entero a una sola celda", () => {
    tablaDePrueba()
    const celda = screen.getAllByRole("cell")[0]
    expect(celda.textContent).toBe("#1418")
    expect(celda.textContent?.trim().split(/\s+/)).toHaveLength(1)
  })

  it("las cifras van a la derecha y con `tabular-nums`", () => {
    tablaDePrueba()
    const total = screen.getByRole("cell", { name: "$ 128.400" })
    expect(total.style.textAlign).toBe("right")
    expect(total.style.fontVariantNumeric).toBe("tabular-nums")
  })

  it("la franja de estado queda declarada en la fila, para poder verla sin leer", () => {
    tablaDePrueba()
    expect(screen.getByRole("row", { name: /#1418/ })).toHaveAttribute("data-status", "critical")
    expect(screen.getByRole("row", { name: /#1419/ })).toHaveAttribute("data-status", "none")
  })

  it("si no cabe, se desliza la tabla: nunca crece la fila", () => {
    const { container } = tablaDePrueba()
    expect(container.querySelector(".overflow-auto")).not.toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 2 · La zona de consecuencia

describe("regla dura · el peligro va en el marco y el botón nunca es rojo", () => {
  it("el marco avisa en rojo y el botón sale azul y secundario", () => {
    const { container } = render(
      <ConsequenceZone
        level="irreversible"
        scope="Sede Chapinero"
        explanation="Lo que no se puede deshacer desde acá."
        action={{
          label: "Rotar el PIN",
          onClick: () => {},
          consequences: ["El PIN anterior deja de servir para activar dispositivos."],
        }}
      />,
    )

    const marco = container.firstElementChild as HTMLElement
    expect(marco.className).toContain("border-destructive")

    const boton = screen.getByRole("button", { name: "Rotar el PIN" })
    // Rojo es ESTADO (`docs/DISENO.md`): no viste un control, ni acá ni en
    // ninguna parte. Azul es lo único que se toca.
    expect(clasesSiemprePuestas(boton)).not.toContain(
      expect.stringMatching(/destructive/),
    )
    expect(boton.className).toContain("text-primary")
    // Y secundario: no es el botón lleno, para que no sea lo más fácil de pulsar.
    expect(clasesSiemprePuestas(boton)).not.toContain("bg-primary")
  })

  it("la zona ámbar marca «cambia otra pantalla» y tampoco pinta el botón", () => {
    const { container } = render(
      <ConsequenceZone
        level="reversible"
        explanation="Apagarlas no borra las 46 fotos ya tomadas."
        action={{
          label: "Apagar la foto obligatoria",
          onClick: () => {},
          consequences: ["La foto deja de pedirse en Salón › Cierre de turno, paso 3."],
        }}
      />,
    )
    expect((container.firstElementChild as HTMLElement).className).toContain("border-warning")
    expect(screen.getByText("Cambia otra pantalla")).toBeInTheDocument()
    expect(
      clasesSiemprePuestas(screen.getByRole("button", { name: "Apagar la foto obligatoria" })),
    ).not.toContain(expect.stringMatching(/destructive/))
  })

  it("la confirmación enumera qué cambia y dónde se va a notar, y recién ahí actúa", async () => {
    const rotar = vi.fn()
    const user = userEvent.setup()
    render(
      <ConsequenceZone
        level="irreversible"
        explanation="El PIN nuevo no se vuelve a mostrar."
        action={{
          label: "Rotar el PIN",
          onClick: rotar,
          consequences: [
            "El PIN anterior deja de servir para activar dispositivos.",
            "Los 4 dispositivos ya activados siguen vendiendo.",
          ],
        }}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Rotar el PIN" }))
    expect(rotar).not.toHaveBeenCalled()

    const dialogo = await screen.findByRole("alertdialog")
    expect(
      within(dialogo).getByText("El PIN anterior deja de servir para activar dispositivos."),
    ).toBeInTheDocument()
    expect(
      within(dialogo).getByText("Los 4 dispositivos ya activados siguen vendiendo."),
    ).toBeInTheDocument()

    const confirmar = within(dialogo).getByRole("button", { name: "Rotar el PIN" })
    expect(clasesSiemprePuestas(confirmar)).not.toContain(expect.stringMatching(/destructive/))
    await user.click(confirmar)
    expect(rotar).toHaveBeenCalledTimes(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 3 · El estado vacío por filtro

describe("regla dura · el vacío por filtro nombra al culpable y ofrece la salida", () => {
  it("nombra el filtro puesto y la salida lo nombra también", async () => {
    const quitar = vi.fn()
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <FilterEmptyState
          title="Sin insumos para estos filtros"
          filters={["Sólo críticos"]}
          totalWithoutFilters={47}
          onRemove={quitar}
        />
      </MemoryRouter>,
    )

    expect(
      screen.getByText("El filtro puesto es «Sólo críticos». Quitalo para ver el resto."),
    ).toBeInTheDocument()
    const salida = screen.getByRole("button", { name: 'Quitar «Sólo críticos» y ver los 47' })
    await user.click(salida)
    expect(quitar).toHaveBeenCalledWith("Sólo críticos")
  })

  it("con varios filtros puestos ofrece sacar cada uno, no «limpiar todo»", async () => {
    // El dueño llegó desde un enlace de Hoy y NO sabe qué se aplicó: una
    // salida que diga «limpiar todo» le borra también el filtro que sí
    // quería.
    const quitar = vi.fn()
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <FilterEmptyState
          title="Sin insumos para estos filtros"
          filters={["Sólo críticos", "Bajo mínimo", "Negativos"]}
          onRemove={quitar}
        />
      </MemoryRouter>,
    )

    expect(screen.queryByRole("button", { name: /limpiar todo/i })).toBeNull()
    await user.click(screen.getByRole("button", { name: 'Quitar «Bajo mínimo»' }))
    expect(quitar).toHaveBeenCalledWith("Bajo mínimo")
  })
})
