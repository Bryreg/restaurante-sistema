import { fireEvent, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import { renderWithProviders } from "@/test/utils"

import LoginPage from "../LoginPage"

const { adminLoginMock } = vi.hoisted(() => ({ adminLoginMock: vi.fn() }))
vi.mock("@/api/auth", async () => {
  const actual = await vi.importActual<typeof import("@/api/auth")>("@/api/auth")
  return { ...actual, adminLogin: adminLoginMock }
})

describe("LoginPage — verificación en dos pasos", () => {
  it("cuando el servidor pide el código, aparece el campo y se reenvía con él", async () => {
    adminLoginMock.mockRejectedValueOnce(new ApiError(401, "TOTP_REQUIRED", "Escribí el código"))
    adminLoginMock.mockResolvedValueOnce({ user: { id: 1, name: "A", role: "admin" }, organization: { id: 1, name: "O" } })
    renderWithProviders(<LoginPage />)

    fireEvent.change(await screen.findByLabelText(/correo/i), { target: { value: "a@b.co" } })
    fireEvent.change(screen.getByLabelText(/^contraseña/i), { target: { value: "clave" } })
    fireEvent.click(screen.getByRole("button", { name: "Ingresar" }))

    const campo = await screen.findByLabelText(/código de verificación/i)
    fireEvent.change(campo, { target: { value: "123456" } })
    fireEvent.click(screen.getByRole("button", { name: "Ingresar" }))
    await waitFor(() =>
      expect(adminLoginMock).toHaveBeenLastCalledWith({ email: "a@b.co", password: "clave", totp_code: "123456" }),
    )
  })

  it("ofrece recuperar la contraseña", async () => {
    renderWithProviders(<LoginPage />)
    expect(await screen.findByRole("link", { name: /olvidé mi contraseña/i })).toHaveAttribute("href", "/recuperar")
  })
})
