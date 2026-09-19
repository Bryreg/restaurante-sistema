import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { renderWithProviders } from "@/test/utils"

import LoginPage from "../LoginPage"

describe("LoginPage — la puerta del POS no se esconde", () => {
  it("ofrece llegar a la activación del dispositivo", async () => {
    // La raíz de la app manda acá. Antes de este enlace, el dueño que montaba
    // una tablet veía un formulario pidiéndole correo y contraseña de
    // administrador, sin nada que lo llevara a `/pos/activate`: tenía que
    // adivinar la URL. Es una acción de una sola vez por aparato, pero es la
    // PRIMERA, y quien no pasa de la primera pantalla concluye que el
    // producto no sirve.
    renderWithProviders(<LoginPage />)

    const enlace = await screen.findByRole("link", { name: /activá este dispositivo/i })
    expect(enlace).toHaveAttribute("href", "/pos/activate")
  })

  it("el enlace no revela nada: activar sigue exigiendo el PIN de sede", async () => {
    renderWithProviders(<LoginPage />)
    const texto = document.body.textContent ?? ""
    expect(texto).not.toMatch(/\b\d{6}\b/)
    expect(texto.toLowerCase()).not.toContain("pin de sede es")
  })

  it("sigue siendo, ante todo, el login del administrador", async () => {
    renderWithProviders(<LoginPage />)
    expect(await screen.findByLabelText(/correo/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/contraseña/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Ingresar" })).toBeInTheDocument()
  })
})
