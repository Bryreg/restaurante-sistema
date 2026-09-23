import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { DesdeHacia } from "../DesdeHacia"
import { Diferencia } from "../Diferencia"
import { SinDato } from "../SinDato"

describe("SinDato — no es cero, se ve rayado y dice qué falta", () => {
  it("dibuja el rótulo y el motivo dentro del rayado", () => {
    const { container } = render(<SinDato motivo="falta el conteo del lunes" />)
    expect(container.querySelector(".sin-dato")).not.toBeNull()
    expect(screen.getByText("Sin datos")).toBeInTheDocument()
    expect(screen.getByText("falta el conteo del lunes")).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/\$\s*0/)
  })
})

describe("Diferencia — la dirección va con flecha y palabra, y la cifra con su signo", () => {
  it("en caja, negativo es faltante y va en rojo", () => {
    render(<Diferencia valor={-18000} />)
    const cifra = screen.getByText(/faltante/)
    expect(cifra.textContent).toMatch(/▼\s*-\$\s?18\.000 faltante/)
    expect(cifra.className).toContain("text-destructive")
  })

  it("en inventario, positivo es faltante y negativo sobrante — sin perder el signo", () => {
    const { rerender } = render(<Diferencia valor={12500} faltaCuando="positivo" />)
    expect(screen.getByText(/faltante/).textContent).toMatch(/▼\s*\$\s?12\.500 faltante/)
    rerender(<Diferencia valor={-12500} faltaCuando="positivo" />)
    const sobra = screen.getByText(/sobrante/)
    expect(sobra.textContent).toMatch(/▲\s*-\$\s?12\.500 sobrante/)
    expect(sobra.className).not.toContain("text-destructive")
  })

  it("cero cuadra, y `null` es «sin datos» con motivo, nunca $ 0 cuadra", () => {
    const { rerender } = render(<Diferencia valor={0} />)
    expect(screen.getByText(/cuadra/)).toBeInTheDocument()
    rerender(<Diferencia valor={null} motivoSinDato="sin conteo de cierre" />)
    expect(screen.queryByText(/cuadra/)).not.toBeInTheDocument()
    expect(screen.getByText("sin conteo de cierre")).toBeInTheDocument()
  })
})

describe("DesdeHacia — dice de dónde sale, adónde va y cuánto", () => {
  it("nombra los dos lugares, el monto y quién autoriza; no inventa cómo queda", () => {
    render(<DesdeHacia desde="El cajón del turno 14" hacia="El sobre SOBRE-0921" monto={750000} autoriza="PIN de administrador" />)
    expect(screen.getByText("El cajón del turno 14")).toBeInTheDocument()
    expect(screen.getByText("El sobre SOBRE-0921")).toBeInTheDocument()
    expect(screen.getByText(/Sale: \$\s?750\.000/)).toBeInTheDocument()
    expect(screen.getByText(/Autoriza: PIN de administrador/)).toBeInTheDocument()
    expect(screen.queryByText(/después/)).not.toBeInTheDocument()
  })

  it("«cómo queda» sólo aparece cuando lo manda el servidor", () => {
    render(<DesdeHacia desde="Caja" hacia="Banco" monto={1000} queda={{ label: "Queda en caja", valor: 434000 }} />)
    expect(screen.getByText(/Queda en caja/)).toHaveTextContent(/434\.000/)
  })
})
