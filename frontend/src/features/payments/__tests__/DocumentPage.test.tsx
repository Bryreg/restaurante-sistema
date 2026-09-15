import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildMe, renderWithProviders } from "@/test/utils";

import DocumentPage from "../DocumentPage";
import { buildDocument } from "./fixtures";

vi.mock("@/api/documents", async () => {
  const actual = await vi.importActual<typeof import("@/api/documents")>("@/api/documents");
  return { ...actual, getDocument: vi.fn(), reprintDocument: vi.fn() };
});

const { getDocument, reprintDocument } = await import("@/api/documents");

function renderDocument(features: Record<string, boolean> = {}) {
  return renderWithProviders(
    <Routes>
      <Route path="/pos/documento/:documentId" element={<DocumentPage />} />
      <Route path="/pos/mesas" element={<div>Mapa de mesas</div>} />
      <Route path="/pos/comanda/nueva" element={<div>Comanda nueva</div>} />
    </Routes>,
    { route: "/pos/documento/900", me: buildMe({ kind: "device", features }) },
  );
}

describe("DocumentPage", () => {
  beforeEach(() => {
    vi.mocked(getDocument).mockReset();
    vi.mocked(reprintDocument).mockReset();
  });

  it("muestra la leyenda tal cual llega y la propina en una línea aparte de la venta", async () => {
    vi.mocked(getDocument).mockResolvedValue(buildDocument());

    renderDocument();

    expect(await screen.findByText("COMPROBANTE INTERNO — no es factura ni documento equivalente")).toBeInTheDocument();
    expect(screen.getByText(/propina voluntaria \(sugerida 10%\)/i)).toBeInTheDocument();
    // El total de la venta no incluye la propina.
    expect(screen.getByText("POS-000123")).toBeInTheDocument();
  });

  it("reimprimir queda contado por el servidor (reprint_count)", async () => {
    vi.mocked(getDocument).mockResolvedValue(buildDocument({ reprint_count: 0 }));
    vi.mocked(reprintDocument).mockResolvedValue(buildDocument({ reprint_count: 1 }));
    const user = userEvent.setup();

    renderDocument();

    expect(await screen.findByText(/reimpresiones: 0/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /reimprimir/i }));

    await waitFor(() => expect(reprintDocument).toHaveBeenCalledWith(900));
    expect(await screen.findByText(/reimpresiones: 1/i)).toBeInTheDocument();
  });

  it("«Volver» respeta pos.tables", async () => {
    vi.mocked(getDocument).mockResolvedValue(buildDocument());
    const user = userEvent.setup();

    renderDocument({ "pos.tables": true });

    await screen.findByText("POS-000123");
    await user.click(screen.getByRole("button", { name: "Volver" }));

    expect(await screen.findByText("Mapa de mesas")).toBeInTheDocument();
  });

  it("«Volver» sin pos.tables va a comanda nueva", async () => {
    vi.mocked(getDocument).mockResolvedValue(buildDocument());
    const user = userEvent.setup();

    renderDocument({ "pos.tables": false });

    await screen.findByText("POS-000123");
    await user.click(screen.getByRole("button", { name: "Volver" }));

    expect(await screen.findByText("Comanda nueva")).toBeInTheDocument();
  });
});
