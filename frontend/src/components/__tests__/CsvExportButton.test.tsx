import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { CsvExportButton } from "../CsvExportButton"

describe("CsvExportButton", () => {
  it("es un enlace al href exacto, con format=csv ya incluido por quien lo llama", () => {
    render(<CsvExportButton href="/api/v1/admin/sales?format=csv&store_id=1" />)
    const link = screen.getByRole("link", { name: "Exportar CSV" })
    expect(link).toHaveAttribute("href", "/api/v1/admin/sales?format=csv&store_id=1")
    expect(link).toHaveAttribute("target", "_blank")
  })

  it("acepta una etiqueta propia", () => {
    render(<CsvExportButton href="/x" label="Descargar informe" />)
    expect(screen.getByRole("link", { name: "Descargar informe" })).toBeInTheDocument()
  })
})
