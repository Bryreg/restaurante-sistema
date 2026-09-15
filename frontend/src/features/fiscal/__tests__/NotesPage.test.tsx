import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/utils";

import { NotesPage } from "../NotesPage";

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}));

const { listNotesMock, createNoteMock, getDocumentMock } = vi.hoisted(() => ({
  listNotesMock: vi.fn(),
  createNoteMock: vi.fn(),
  getDocumentMock: vi.fn(),
}));

vi.mock("@/api/fiscal", async () => {
  const actual = await vi.importActual<typeof import("@/api/fiscal")>("@/api/fiscal");
  return { ...actual, listNotes: listNotesMock, createNote: createNoteMock };
});

vi.mock("@/api/documents", async () => {
  const actual = await vi.importActual<typeof import("@/api/documents")>("@/api/documents");
  return { ...actual, getDocument: getDocumentMock };
});

describe("NotesPage", () => {
  it("deja clarísimo que el documento original queda reversado, nunca editado ni borrado", async () => {
    listNotesMock.mockResolvedValue([]);

    renderWithProviders(<NotesPage />);

    await waitFor(() => expect(listNotesMock).toHaveBeenCalled());
    expect(screen.getByText(/reversado/i)).toBeInTheDocument();
  });

  it("con ?document= precargado, busca el documento y ofrece sus líneas para armar la nota", async () => {
    listNotesMock.mockResolvedValue([]);
    getDocumentMock.mockResolvedValue({
      id: 900,
      full_number: "POS-000900",
      document_type: "pos_equivalent",
      total: 50000,
      lines: [{ item_id: 100, qty: 2, description: "Hamburguesa clásica", net: 50000 }],
    });

    renderWithProviders(<NotesPage />, { route: "/admin/fiscal/notas?document=900" });

    expect(await screen.findByText(/POS-000900/)).toBeInTheDocument();
    expect(screen.getByText("Hamburguesa clásica")).toBeInTheDocument();
    expect(screen.getByLabelText("Tipo de nota")).toBeInTheDocument();
  });

  it("lista las notas existentes con el documento que corrigen", async () => {
    listNotesMock.mockResolvedValue([
      {
        id: 901,
        full_number: "POS-NA-000001",
        document_type: "adjustment_note",
        reverses_document_id: 900,
        reason: "Cliente se fue sin pagar un plato",
        total: -12000,
        business_date: "2026-09-15",
        issued_at: "2026-09-15T19:00:00Z",
      },
    ]);

    renderWithProviders(<NotesPage />);

    expect(await screen.findByText("POS-NA-000001")).toBeInTheDocument();
    expect(screen.getByText(/documento #900 \(reversado\)/i)).toBeInTheDocument();
  });
});
