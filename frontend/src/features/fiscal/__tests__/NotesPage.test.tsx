import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("B-1 (ronda 2): por línea tildada exige elegir «vuelve al inventario» antes de dejar emitir, y el payload lleva returns_to_stock explícito", async () => {
    const user = userEvent.setup();
    listNotesMock.mockResolvedValue([]);
    getDocumentMock.mockResolvedValue({
      id: 900,
      full_number: "FE-000900",
      document_type: "invoice",
      total: 80000,
      lines: [
        { item_id: 100, qty: 1, description: "Hamburguesa clásica", net: 50000 },
        { item_id: 200, qty: 1, description: "Papas fritas", net: 30000 },
      ],
    });
    createNoteMock.mockResolvedValue({ id: 950, returned_to_stock_item_ids: [100] });

    renderWithProviders(<NotesPage />, { route: "/admin/fiscal/notas?document=900" });

    expect(await screen.findByText(/FE-000900/)).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Tipo de nota" }));
    await user.click(await screen.findByRole("option", { name: "Nota crédito" }));
    await user.type(screen.getByLabelText("Motivo"), "Cliente devolvió la hamburguesa");

    // Todavía nadie tildó ninguna línea: no hay nada que emitir.
    const emitButton = screen.getByRole("button", { name: "Emitir nota" });
    expect(emitButton).toBeDisabled();

    // Se tilda la línea 100: ahora hay una elección pendiente y sigue sin poder emitir.
    await user.click(screen.getByLabelText("Incluir Hamburguesa clásica en la nota"));
    expect(emitButton).toBeDisabled();
    expect(screen.getByText(/elegí una opción para poder emitir la nota/i)).toBeInTheDocument();

    // La línea 200 (no tildada) nunca pide elección: no hay radios para ella.
    expect(screen.queryByRole("radiogroup", { name: /papas fritas/i })).not.toBeInTheDocument();

    // Se elige explícitamente "vuelve al inventario" para la línea 100.
    await user.click(screen.getByRole("radio", { name: "Vuelve al inventario" }));
    expect(emitButton).not.toBeDisabled();
    expect(screen.getByText(/los insumos de este plato vuelven al stock teórico/i)).toBeInTheDocument();

    await user.click(emitButton);

    await waitFor(() => expect(createNoteMock).toHaveBeenCalled());
    expect(createNoteMock).toHaveBeenLastCalledWith(
      900,
      expect.objectContaining({
        kind: "credit",
        lines: [
          { item_id: 100, used: true, returns_to_stock: true },
          { item_id: 200, used: false, returns_to_stock: false },
        ],
      }),
      expect.any(String),
    );

    // El aviso posterior refleja lo que el backend dice que volvió al inventario.
    expect(await screen.findByText("1 ítem volvió al inventario.")).toBeInTheDocument();
  });

  it("B-1 (ronda 2): en nota débito no se ofrece la elección y el payload manda returns_to_stock false en todas las líneas", async () => {
    const user = userEvent.setup();
    listNotesMock.mockResolvedValue([]);
    getDocumentMock.mockResolvedValue({
      id: 901,
      full_number: "FE-000901",
      document_type: "invoice",
      total: 20000,
      lines: [{ item_id: 300, qty: 1, description: "Servicio a domicilio", net: 20000 }],
    });
    createNoteMock.mockResolvedValue({ id: 951, returned_to_stock_item_ids: [] });

    renderWithProviders(<NotesPage />, { route: "/admin/fiscal/notas?document=901" });

    expect(await screen.findByText(/FE-000901/)).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Tipo de nota" }));
    await user.click(await screen.findByRole("option", { name: "Nota débito" }));
    await user.type(screen.getByLabelText("Motivo"), "Cobro adicional del domicilio");
    await user.click(screen.getByLabelText("Incluir Servicio a domicilio en la nota"));

    // Débito: cobra más, no devuelve producto — nunca se pregunta.
    expect(screen.queryByRole("radio", { name: "Vuelve al inventario" })).not.toBeInTheDocument();
    expect(screen.getByText("No aplica (nota débito)")).toBeInTheDocument();

    const emitButton = screen.getByRole("button", { name: "Emitir nota" });
    expect(emitButton).not.toBeDisabled();
    await user.click(emitButton);

    await waitFor(() => expect(createNoteMock).toHaveBeenCalled());
    expect(createNoteMock).toHaveBeenLastCalledWith(
      901,
      expect.objectContaining({
        kind: "debit",
        lines: [{ item_id: 300, used: true, returns_to_stock: false }],
      }),
      expect.any(String),
    );

    expect(await screen.findByText("Ningún ítem volvió al inventario.")).toBeInTheDocument();
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
