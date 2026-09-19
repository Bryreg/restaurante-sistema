import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SupplierOut } from "@/api/purchases"

import { defaultDateRange, downloadSuppliersCsv, formatPct, supplierName } from "../lib"

describe("formatPct — null no es 0", () => {
  it("un porcentaje null se dice «sin datos», nunca «0 %»", () => {
    expect(formatPct(null)).toBe("sin datos")
  })

  it("un porcentaje real (ya calculado por el servidor) se muestra tal cual, sin recalcular", () => {
    expect(formatPct(0)).toBe("0 %")
    expect(formatPct(87)).toBe("87 %")
  })
})

describe("supplierName", () => {
  it("resuelve el nombre por id; si no está en la lista, no inventa uno", () => {
    const suppliers: SupplierOut[] = [
      { id: 1, store_id: 1, name: "Distribuidora El Surtidor", nit: null, payment_term_days: 30, contact_name: null, contact_phone: null, invoices_required: true, active: true },
    ]
    expect(supplierName(suppliers, 1)).toBe("Distribuidora El Surtidor")
    expect(supplierName(suppliers, 99)).toBe("Proveedor #99")
  })
})

describe("downloadSuppliersCsv — «toda lista exporta», armado en el cliente por el hueco de contrato (sin format=csv en /admin/suppliers)", () => {
  it("serializa las columnas ya traídas (sin derivar nada nuevo) y dispara una descarga", async () => {
    const supplier: SupplierOut = {
      id: 1,
      store_id: 1,
      name: 'Proveedor, "Grande" S.A.',
      nit: "900123456",
      payment_term_days: 30,
      contact_name: "Ana",
      contact_phone: "3001234567",
      invoices_required: true,
      active: true,
    }

    let capturedBlob: Blob | null = null
    const createObjectURL = vi.fn((blob: Blob) => {
      capturedBlob = blob
      return "blob:mock-url"
    })
    const revokeObjectURL = vi.fn()
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

    downloadSuppliersCsv([supplier])

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url")

    const text = await capturedBlob!.text()
    expect(text).toContain('"Proveedor, ""Grande"" S.A."')
    expect(text).toContain("900123456")
    expect(text).toContain("true")

    clickSpy.mockRestore()
    vi.unstubAllGlobals()
  })
})

describe("defaultDateRange — fecha de negocio en America/Bogota, nunca la UTC del navegador (H-6, ronda 2)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("a las 20:30 de Bogotá (01:30 UTC del día siguiente), `to` es la fecha local, no la de UTC", () => {
    // Bogotá es UTC-5 todo el año (sin horario de verano): 2026-09-16 20:30
    // local == 2026-09-17T01:30:00Z. Un `to` armado con
    // `new Date().toISOString().slice(0, 10)` daría "2026-09-17" (mañana,
    // según UTC) — el bug real que este test fija.
    vi.setSystemTime(new Date("2026-09-17T01:30:00Z"))

    const range = defaultDateRange(90)

    expect(range.to).toBe("2026-09-16")
    // El `from` es exactamente 90 días antes de ESA fecha (2026-09-16), no
    // de la fecha UTC ni de "ahora" sin zona.
    expect(range.from).toBe("2026-06-18")
  })
})
