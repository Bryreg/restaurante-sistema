import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/utils";

import { DocumentsPage } from "../DocumentsPage";

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}));

const { listFiscalDocumentsMock, retryFiscalDocumentMock, getFiscalDocumentEvidenceMock } = vi.hoisted(() => ({
  listFiscalDocumentsMock: vi.fn(),
  retryFiscalDocumentMock: vi.fn(),
  getFiscalDocumentEvidenceMock: vi.fn(),
}));

vi.mock("@/api/fiscal", async () => {
  const actual = await vi.importActual<typeof import("@/api/fiscal")>("@/api/fiscal");
  return {
    ...actual,
    listFiscalDocuments: listFiscalDocumentsMock,
    retryFiscalDocument: retryFiscalDocumentMock,
    getFiscalDocumentEvidence: getFiscalDocumentEvidenceMock,
  };
});

const REJECTED_ROW = {
  id: 900,
  full_number: "POS-000900",
  document_type: "pos_equivalent" as const,
  dian_status: "rejected" as const,
  contingency: false,
  contingency_overdue: false,
  business_date: "2026-09-15",
  issued_at: "2026-09-15T18:00:00Z",
  order_id: 42,
  total: 50000,
  tip_amount: 4630,
  charged_by: "Ana",
  customer_name: "Consumidor final",
  reverses_document_id: null,
};

describe("DocumentsPage", () => {
  it("el estado se ve con texto, no sólo color, y ofrece reintentar sobre un documento rechazado", async () => {
    listFiscalDocumentsMock.mockResolvedValue([REJECTED_ROW]);
    retryFiscalDocumentMock.mockResolvedValue({ id: 900, dian_status: "sent" });
    const user = userEvent.setup();

    renderWithProviders(<DocumentsPage />);

    await waitFor(() => expect(screen.getByText("POS-000900")).toBeInTheDocument());
    expect(screen.getByText("Rechazado")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(retryFiscalDocumentMock).toHaveBeenCalledWith(900, expect.any(String)));
  });

  it("evidencia muestra CUDE, QR y el hash del contenido", async () => {
    listFiscalDocumentsMock.mockResolvedValue([{ ...REJECTED_ROW, dian_status: "validated" }]);
    getFiscalDocumentEvidenceMock.mockResolvedValue({
      id: 900,
      full_number: "POS-000900",
      dian_status: "validated",
      cude: "CUDE-XYZ",
      qr_url: "https://dian.gov.co/qr",
      xml_ref: null,
      provider_response: { status: "ok" },
      validated_at: "2026-09-15T18:01:00Z",
      issued_at: "2026-09-15T18:00:00Z",
      content_hash: "abc123",
      range: null,
    });
    const user = userEvent.setup();

    renderWithProviders(<DocumentsPage />);

    await waitFor(() => expect(screen.getByText("POS-000900")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Evidencia" }));

    expect(await screen.findByText("CUDE-XYZ")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
  });

  it("un rechazo no es un 500: el error de la lista se muestra como texto legible", async () => {
    listFiscalDocumentsMock.mockRejectedValue(new Error("Error del servidor (500). Intentá de nuevo."));

    renderWithProviders(<DocumentsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/no se pudieron cargar los documentos/i);
  });
});
