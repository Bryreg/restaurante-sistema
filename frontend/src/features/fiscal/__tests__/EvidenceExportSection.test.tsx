import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/utils";

import { EvidenceExportSection } from "../EvidenceExportSection";
import { previousMonth, previousYear } from "../periods";

const { getFiscalExportBundleMock } = vi.hoisted(() => ({ getFiscalExportBundleMock: vi.fn() }));

vi.mock("@/api/fiscal", async () => {
  const actual = await vi.importActual<typeof import("@/api/fiscal")>("@/api/fiscal");
  return { ...actual, getFiscalExportBundle: getFiscalExportBundleMock };
});

function setPeriod(from: string, to: string): void {
  fireEvent.change(screen.getByLabelText("Desde"), { target: { value: from } });
  fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: to } });
}

describe("EvidenceExportSection — c7: exportar la evidencia fiscal", () => {
  it("dice en pantalla que la ley pide guardarla 5 años", () => {
    renderWithProviders(<EvidenceExportSection storeId={1} />);
    expect(screen.getByTestId("fiscal-export-retention")).toHaveTextContent(/5 años/);
  });

  it("sin período no ofrece descargar nada", () => {
    renderWithProviders(<EvidenceExportSection storeId={1} />);
    expect(screen.queryByRole("link", { name: /Descargar paquete/ })).not.toBeInTheDocument();
    expect(screen.getByText(/un paquete sin período no es evidencia/)).toBeInTheDocument();
  });

  it("con período, el paquete se descarga como archivo y se puede ver qué lleva", async () => {
    getFiscalExportBundleMock.mockResolvedValue({
      generated_at: "2026-10-01T15:00:00Z",
      store_id: 1,
      date_from: "2026-09-01",
      date_to: "2026-09-30",
      document_count: 412,
      documents: [],
      manifest_hash: "abc123def456",
    });
    const user = userEvent.setup();
    renderWithProviders(<EvidenceExportSection storeId={1} />);

    setPeriod("2026-09-01", "2026-09-30");
    const download = screen.getByRole("link", { name: /Descargar paquete \(\.json\)/ });
    expect(download.getAttribute("href")).toBe(
      "/api/v1/admin/fiscal/export?store_id=1&from=2026-09-01&to=2026-09-30&download=true",
    );

    await user.click(screen.getByRole("button", { name: "Ver qué lleva" }));
    await waitFor(() =>
      expect(getFiscalExportBundleMock).toHaveBeenCalledWith({ storeId: 1, from: "2026-09-01", to: "2026-09-30" }),
    );
    const preview = await screen.findByTestId("fiscal-export-preview");
    expect(preview).toHaveTextContent("412");
    expect(preview).toHaveTextContent("abc123def456");
  });

  it("un período al revés se avisa y no se descarga", () => {
    renderWithProviders(<EvidenceExportSection storeId={1} />);
    setPeriod("2026-09-30", "2026-09-01");
    expect(screen.getByRole("alert")).toHaveTextContent(/anterior o igual/);
    expect(screen.queryByRole("link", { name: /Descargar paquete/ })).not.toBeInTheDocument();
  });

  it("los atajos de período son meses y años calendario completos", () => {
    expect(previousMonth("2026-10-06")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(previousMonth("2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(previousMonth("2028-03-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(previousYear("2026-10-06")).toEqual({ from: "2025-01-01", to: "2025-12-31" });
  });
});
