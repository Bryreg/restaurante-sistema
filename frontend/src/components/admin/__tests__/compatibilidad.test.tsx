/**
 * **Los dos componentes que ya existían no se reemplazaron: se extendieron.**
 *
 * `EmptyState` tiene 90 usos y `StatTile` 74. Todo lo que la ola 1 les agregó
 * es opcional y con el comportamiento de hoy por defecto; este archivo lo
 * comprueba desde el otro lado, dibujando **exactamente las formas de props
 * que ya están escritas en las pantallas** y afirmando que dan lo mismo que
 * daban. Que compilen lo comprueba `npx tsc --noEmit -p tsconfig.app.json`;
 * que se comporten igual, esto.
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AlertCircle, Users } from "lucide-react"
import { describe, expect, it, vi } from "vitest"

import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"

describe("EmptyState · los 90 usos anteriores dibujan lo mismo", () => {
  it("`<EmptyState title />` a secas sigue siendo un `status` con tinta apagada", () => {
    // La forma más usada de todas: `<EmptyState title="No hay rondas pendientes" />`.
    const { container } = render(<EmptyState title="No hay rondas pendientes" />)
    const caja = container.firstElementChild as HTMLElement
    expect(caja).toHaveAttribute("role", "status")
    expect(caja.className).toBe(
      "flex flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center",
    )
    const icono = caja.querySelector("svg") as SVGElement
    expect(icono.getAttribute("class")).toContain("text-muted-foreground")
    // Sin motivo, ningún color de estado se cuela en el ícono.
    expect(icono.getAttribute("class")).not.toMatch(/text-(success|destructive|warning)/)
  })

  it("`role=\"alert\"` + `description` + `icon` + `action` sigue igual", async () => {
    // `features/payroll/HoursTab.tsx` y otras cuarenta: el camino de error.
    const reintentar = vi.fn()
    const user = userEvent.setup()
    render(
      <EmptyState
        role="alert"
        title="No se pudo cargar la jornada"
        description="El servidor no respondió"
        icon={AlertCircle}
        action={{ label: "Reintentar", onClick: reintentar }}
      />,
    )
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.getByText("El servidor no respondió")).toBeInTheDocument()
    const boton = screen.getByRole("button", { name: "Reintentar" })
    // Secundario, como era: la ola 1 no ascendió a primario ningún botón ya escrito.
    expect(boton.className).toContain("bg-background")
    expect(boton.className).not.toMatch(/\bbg-primary\b/)
    await user.click(boton)
    expect(reintentar).toHaveBeenCalledTimes(1)
  })

  it("`icon` explícito gana sobre el ícono del motivo", () => {
    const { container } = render(
      <EmptyState title="No hay nadie disponible para elegir" icon={Users} reason="dependency" />,
    )
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("el motivo es lo único que cambia el dibujo, y sólo cuando se pasa", () => {
    const { container: sinMotivo } = render(<EmptyState title="Todo al día" />)
    const { container: conMotivo } = render(<EmptyState title="Todo al día" reason="all-clear" />)
    expect(sinMotivo.querySelector("svg")?.getAttribute("class")).toContain("text-muted-foreground")
    expect(conMotivo.querySelector("svg")?.getAttribute("class")).toContain("text-success")
  })
})

describe("StatTile · las 74 tarjetas anteriores dibujan lo mismo", () => {
  it("`label` + `value` sigue siendo rótulo y cifra, sin tono", () => {
    // `features/orders/OrdersAdminPage.tsx`: `<StatTile label value={String(...)} />`.
    const { container } = render(<StatTile label="Comandas en el período" value="148" />)
    const tarjeta = container.firstElementChild as HTMLElement
    expect(tarjeta.className).toContain("border-border")
    expect(screen.getByText("148").className).toContain("text-foreground")
    expect(screen.getByText("148").className).toContain("tabular-nums")
  })

  it("`tone=\"critical\"` conserva su teñido y su cifra roja", () => {
    // `features/expenses/ProfitTab.tsx`: la utilidad negativa.
    const { container } = render(<StatTile label="Utilidad" value="-$ 1.000" tone="critical" />)
    const tarjeta = container.firstElementChild as HTMLElement
    expect(tarjeta.className).toContain("border-destructive/30")
    expect(tarjeta.className).toContain("bg-destructive/5")
    expect(screen.getByText("-$ 1.000").className).toContain("text-destructive")
  })

  it("`tone=\"warning\"` conserva su teñido neutro: la ola 1 no repintó de ámbar 74 tarjetas", () => {
    // `features/expenses/BreakEvenTab.tsx` usa `warning` como ÉNFASIS, no
    // como alerta. Cambiarle el fondo a ámbar le habría puesto un color de
    // estado a un número que no está mal.
    const { container } = render(<StatTile label="Punto de equilibrio" value="$ 9.000.000" tone="warning" />)
    const tarjeta = container.firstElementChild as HTMLElement
    expect(tarjeta.className).toContain("bg-secondary/50")
    expect(screen.getByText("$ 9.000.000").className).toContain("text-foreground")
  })

  it("el «—» que las pantallas ya mandan como texto sigue siendo un `value` cualquiera", () => {
    // `features/inventory/ControlHealthTab.tsx` arma el guión con un ternario
    // antes de llegar acá. Ese camino no cambió: el `value: null` con su
    // nota es una forma NUEVA, no un reemplazo.
    render(<StatTile label="Días desde el último conteo completo" value="—" />)
    expect(screen.getByText("—")).toBeInTheDocument()
  })

  it("`hint` e `icon` siguen donde estaban", () => {
    const { container } = render(
      <StatTile
        label="Ítems enviados al cobrar"
        value="12 %"
        hint="Debieron enviarse a cocina antes de presentar la cuenta"
        icon={AlertCircle}
      />,
    )
    expect(screen.getByText("Debieron enviarse a cocina antes de presentar la cuenta")).toBeInTheDocument()
    expect(container.querySelector("svg")).not.toBeNull()
  })
})
