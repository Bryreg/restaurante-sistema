/**
 * Dos defectos de la coraza compartida que encontró la demo de un día de
 * venta. Los dos aparecen en muchas pantallas y en ninguna en particular,
 * por eso viven acá y no en el `__tests__` de un dominio.
 */
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

// ---------------------------------------------------------------------------

/** El patrón natural de «todavía no eligió nada», usado en el diálogo de
 * anulación, el de descuento, el de cortesía y los tres pasos del cierre. */
function CausaTipada({ causa }: { causa: string }) {
  return (
    <Select value={causa || undefined} onValueChange={() => {}}>
      <SelectTrigger aria-label="Causa">
        <SelectValue placeholder="Elegí una causa" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="kitchen_error">Error de cocina</SelectItem>
      </SelectContent>
    </Select>
  )
}

describe("un selector sin valor elegido no cambia de no-controlado a controlado", () => {
  it("elegir la primera causa no avisa por consola", () => {
    // El aviso real que salía en cada diálogo con causa tipada, al momento
    // de elegir:
    //   «Base UI: A component is changing the uncontrolled value state of
    //    Select to be controlled.»
    // Hoy no rompe nada, pero es el aviso que precede a un valor que se
    // pierde al reabrir el diálogo. El estado controlado «sin valor» de Base
    // UI es `null`, no `undefined`, y eso se normaliza una sola vez en el
    // envoltorio de `Select` — no en los veinticinco sitios de llamada.
    //
    // La transición se provoca con un `rerender`, no abriendo el desplegable:
    // el popup de base-ui se monta en un portal y en jsdom es flaky, y lo que
    // importa medir es el cambio de `undefined` a un valor, que es lo que
    // dispara el aviso.
    const avisos: string[] = []
    const capturar = (...args: unknown[]) => void avisos.push(args.map(String).join(" "))
    const espiaError = vi.spyOn(console, "error").mockImplementation(capturar)
    const espiaWarn = vi.spyOn(console, "warn").mockImplementation(capturar)
    try {
      const { rerender } = render(<CausaTipada causa="" />)
      expect(screen.getByLabelText("Causa")).toBeInTheDocument()
      rerender(<CausaTipada causa="kitchen_error" />)
    } finally {
      espiaError.mockRestore()
      espiaWarn.mockRestore()
    }
    expect(avisos.filter((a) => /uncontrolled|controlled/i.test(a))).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe("la coraza compartida habla español", () => {
  it("el botón de cerrar de un diálogo se llama «Cerrar», no «Close»", () => {
    // AGENTS.md: la UI va en español. El botón venía del componente base sin
    // traducir, así que decía «Close» en TODOS los diálogos de la app — y es
    // el único nombre que tiene para quien navega con lector de pantalla.
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Anular Ajiaco santafereño</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument()
  })
})
