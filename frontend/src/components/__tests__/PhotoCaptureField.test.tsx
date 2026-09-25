/**
 * Mientras la foto se achica (`@/lib/foto`, puede tardar un par de segundos
 * en la tablet) el campo lo dice —«Procesando foto…»— y avisa a quien arma
 * el formulario, para que no se envíe sin la foto que la persona ya eligió.
 */
import { act, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { PhotoCaptureField } from "../PhotoCaptureField"

const fotoMock = vi.hoisted(() => ({ fotoParaEnviar: vi.fn() }))
vi.mock("@/lib/foto", () => fotoMock)

function Harness({ onProcessing }: { onProcessing: (p: boolean) => void }): React.JSX.Element {
  const [photo, setPhoto] = useState<string | null>(null)
  return <PhotoCaptureField value={photo} onChange={setPhoto} label="Foto" onProcessingChange={onProcessing} />
}

describe("PhotoCaptureField — procesando", () => {
  it("muestra «Procesando foto…» y avisa mientras achica; al terminar, la miniatura", async () => {
    let resolve: (dataUrl: string) => void = () => {}
    fotoMock.fotoParaEnviar.mockReturnValue(new Promise<string>((r) => (resolve = r)))
    const onProcessing = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<Harness onProcessing={onProcessing} />)

    const file = new File(["x"], "recibo.jpg", { type: "image/jpeg" })
    await user.upload(screen.getByLabelText("Foto"), file)

    expect(screen.getByRole("status")).toHaveTextContent("Procesando foto…")
    expect(onProcessing).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole("button", { name: /tomar o elegir foto/i })).toBeDisabled()

    await act(async () => resolve("data:image/jpeg;base64,abc"))

    expect(screen.queryByText("Procesando foto…")).not.toBeInTheDocument()
    expect(onProcessing).toHaveBeenLastCalledWith(false)
    expect(screen.getByRole("img")).toHaveAttribute("src", "data:image/jpeg;base64,abc")
  })

  it("si achicar falla, deja de procesar y muestra el error", async () => {
    fotoMock.fotoParaEnviar.mockRejectedValue(new Error("No se pudo leer la foto"))
    const onProcessing = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<Harness onProcessing={onProcessing} />)

    await user.upload(screen.getByLabelText("Foto"), new File(["x"], "a.jpg", { type: "image/jpeg" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo leer la foto")
    expect(onProcessing).toHaveBeenLastCalledWith(false)
  })
})
