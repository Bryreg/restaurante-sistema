/**
 * Dos defectos que ningún test automático vio y que encontró el recorrido en
 * navegador real de la fase 3. Los dos son de la misma familia: componentes
 * compartidos que se portan distinto cuando alguien los usa de verdad.
 *
 * Quedan acá, en `src/audit/`, y no en el `__tests__` de un dominio, porque no
 * son de un dominio: `MoneyInput` está en 18 pantallas y `PinPad` en todas las
 * que autorizan algo.
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"

import { MoneyInput } from "@/components/MoneyInput"
import { PinPad } from "@/components/PinPad"

// ---------------------------------------------------------------------------

function CampoConBoton() {
  const [v, setV] = useState<number | null>(null)
  return (
    <div>
      <label htmlFor="m">Monto</label>
      <MoneyInput id="m" value={v} onChange={setV} />
      <button type="button" disabled={v === null || v <= 0}>
        Guardar
      </button>
    </div>
  )
}

describe("MoneyInput avisa el monto mientras se teclea, no sólo al salir del campo", () => {
  it("el botón que depende del monto se habilita SIN tener que salir del campo", async () => {
    // El defecto: `MoneyInput` sólo llamaba a `onChange` en `onBlur`. Un
    // formulario que habilita su botón según el monto —casi todos los de
    // plata de esta app— seguía con el botón deshabilitado mientras el campo
    // tuviera el foco. Y hacer clic en un botón deshabilitado **no saca el
    // foco del campo** en Chromium: el mousedown se descarta. La persona
    // teclea, ve el botón gris y no tiene cómo destrabarlo salvo adivinar que
    // primero hay que tocar en otro lado.
    const user = userEvent.setup()
    render(<CampoConBoton />)

    expect(screen.getByRole("button", { name: "Guardar" })).toBeDisabled()
    await user.type(screen.getByLabelText("Monto"), "50000")

    // SIN blur, sin tocar nada más.
    expect(screen.getByRole("button", { name: "Guardar" })).toBeEnabled()
  })

  it("lo que se teclea no se reescribe a mitad de palabra", async () => {
    const user = userEvent.setup()
    render(<CampoConBoton />)
    const campo = screen.getByLabelText<HTMLInputElement>("Monto")
    await user.type(campo, "12345")
    expect(campo.value).toBe("12345")
  })
})

// ---------------------------------------------------------------------------

function PantallaConPinYCampo({ onSubmit }: { onSubmit: (pin: string) => void }) {
  const [v, setV] = useState<number | null>(null)
  return (
    <div>
      <label htmlFor="monto">Monto</label>
      <MoneyInput id="monto" value={v} onChange={setV} />
      <PinPad length={4} label="PIN de administrador" disabled={v === null || v <= 0} onSubmit={onSubmit} />
    </div>
  )
}

describe("PinPad no se come las teclas de otro campo", () => {
  it("teclear un monto con el PIN habilitado NO dispara el PIN", async () => {
    // El defecto real, encontrado pagando una cuenta por pagar: el atajo de
    // teclado del PIN escucha en `window`. Al teclear «50000», el primer
    // dígito hace válido el monto, el PIN se habilita y se traga los CUATRO
    // ceros siguientes. Cuatro dígitos es un PIN completo: **dispara el pago
    // solo, con un PIN inventado**. Y un PIN equivocado cuenta para el
    // bloqueo por intentos fallidos, así que además deja a la persona fuera.
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<PantallaConPinYCampo onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText("Monto"), "50000")

    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("pero con el foco fuera de un campo, el atajo de teclado sigue andando", async () => {
    // La guarda no puede romper el atajo: tener que enfocar el teclado
    // numérico antes de teclear el PIN es justamente lo que se quería evitar.
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<PantallaConPinYCampo onSubmit={onSubmit} />)

    // Monto válido sin teclear (se habilita el PIN), y el foco fuera del campo.
    await user.type(screen.getByLabelText("Monto"), "1")
    await user.click(screen.getByRole("group", { name: "PIN de administrador" }))

    await user.keyboard("1234")
    expect(onSubmit).toHaveBeenCalledWith("1234")
  })
})
