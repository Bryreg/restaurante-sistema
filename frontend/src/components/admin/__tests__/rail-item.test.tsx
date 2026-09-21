/**
 * **La fila del rail** (`docs/PATRONES-ADMIN.md` § 1). Lo que afirma acá es
 * lo que las veinticinco entradas y los tres controles del pie dan por
 * hecho; si una de estas se rompe, se rompe en los veintiocho lugares.
 */
import { render, screen } from "@testing-library/react"
import { Package } from "lucide-react"
import { describe, expect, it } from "vitest"

import { RailItemContent, railItemClass } from "@/components/admin/RailItem"

function fila(props: Parameters<typeof RailItemContent>[0]) {
  return render(
    <a href="/x" className={railItemClass()} aria-label="Inventario">
      <RailItemContent {...props} />
    </a>,
  )
}

describe("RailItemContent · el recuento", () => {
  it("dibuja el número cuando lo hay", () => {
    fila({ icon: Package, label: "Inventario", count: 14 })
    expect(screen.getByText("14")).toBeInTheDocument()
  })

  it("en `0` no dibuja nada: una insignia permanente en cero es ruido", () => {
    fila({ icon: Package, label: "Inventario", count: 0 })
    expect(screen.queryByText("0")).toBeNull()
  })

  it("sin dato (`undefined`/`null`) tampoco inventa un `0` mientras carga", () => {
    const { rerender } = fila({ icon: Package, label: "Inventario" })
    expect(screen.queryByText(/\d/)).toBeNull()
    rerender(
      <a href="/x" className={railItemClass()} aria-label="Inventario">
        <RailItemContent icon={Package} label="Inventario" count={null} />
      </a>,
    )
    expect(screen.queryByText(/\d/)).toBeNull()
  })

  it("el número no entra dos veces en el nombre accesible: lo dice el `aria-label` del enlace", () => {
    render(
      <a href="/x" className={railItemClass()} aria-label="Inventario, 14 insumos en alerta">
        <RailItemContent icon={Package} label="Inventario" count={14} />
      </a>,
    )
    expect(screen.getByRole("link")).toHaveAccessibleName("Inventario, 14 insumos en alerta")
    expect(screen.getByText("14")).toHaveAttribute("aria-hidden", "true")
  })
})

describe("RailItemContent · el rótulo", () => {
  it("se recorta en vez de crecer: una entrada de dos líneas mueve las de abajo", () => {
    fila({ icon: Package, label: "Devoluciones" })
    expect(screen.getByText("Devoluciones").className).toContain("truncate")
  })

  it("el ícono no se lee: el rótulo ya dice qué es", () => {
    const { container } = fila({ icon: Package, label: "Inventario" })
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
  })
})

describe("railItemClass · dónde estás parado", () => {
  it("la entrada activa usa la marca llena, como en la maqueta a2", () => {
    // Era `bg-accent`, porque `docs/DISENO.md` le asigna a `accent` «lo
    // elegido: fila activa, navegación actual». El dueño miró la app contra
    // la maqueta `a2` —que marca la entrada activa con la marca llena,
    // `.nav-i[aria-current="page"]{background:var(--brand);color:#fff}`— y
    // pidió ésa. La regla dura del color sigue en pie: lo que cambió es cuál
    // de los dos azules marca dónde estás, no que un ESTADO —verde, ámbar,
    // rojo— se haya vuelto acción.
    const activa = railItemClass({ active: true })
    expect(activa).toContain("bg-primary")
    expect(activa).toContain("text-primary-foreground")
  })

  it("la entrada quieta no lleva fondo, y se enciende al pasar por encima", () => {
    const quieta = railItemClass()
    // Las clases **sin variante** son las que pintan siempre; `hover:bg-accent`
    // no pinta nada hasta que el mouse llega (mismo criterio que
    // `reglas-duras.test.tsx`).
    const siempre = quieta.split(/\s+/).filter((c) => c.length > 0 && !c.includes(":"))
    expect(siempre.filter((c) => c.startsWith("bg-"))).toEqual([])
    expect(quieta).toContain("hover:bg-accent")
  })

  it("en el cajón del móvil la fila crece al objetivo táctil", () => {
    expect(railItemClass({ touch: true })).toContain("min-h-11")
    expect(railItemClass()).toContain("min-h-8")
  })

  it("ningún color crudo de Tailwind: los tokens ya saben cambiar con el tema", () => {
    const todas = [railItemClass(), railItemClass({ active: true }), railItemClass({ touch: true })]
    for (const clases of todas) {
      expect(clases).not.toMatch(
        /\b[a-z-]+-(red|amber|green|emerald|blue|slate|gray|zinc|neutral)-[0-9]{2,3}\b/,
      )
    }
  })
})
