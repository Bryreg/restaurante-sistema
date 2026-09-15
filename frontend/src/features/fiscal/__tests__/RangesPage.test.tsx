import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/utils";

import { RangesPage } from "../RangesPage";

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}));

const { listFiscalRangesMock, createFiscalRangeMock } = vi.hoisted(() => ({
  listFiscalRangesMock: vi.fn(),
  createFiscalRangeMock: vi.fn(),
}));

vi.mock("@/api/fiscal", async () => {
  const actual = await vi.importActual<typeof import("@/api/fiscal")>("@/api/fiscal");
  return { ...actual, listFiscalRanges: listFiscalRangesMock, createFiscalRange: createFiscalRangeMock };
});

describe("RangesPage", () => {
  it("muestra el avance del rango y la alerta al 80% consumido", async () => {
    listFiscalRangesMock.mockResolvedValue([
      {
        id: 1,
        store_id: 1,
        document_type: "pos_equivalent",
        prefix: "POS",
        from_number: 1,
        to_number: 100,
        resolution_number: "18760000001",
        resolution_date: "2026-01-01",
        valid_from: "2026-01-01",
        valid_until: "2026-12-31",
        technical_key: null,
        consumed: 85,
      },
    ]);

    renderWithProviders(<RangesPage />);

    await waitFor(() => expect(screen.getByText("POS")).toBeInTheDocument());
    expect(screen.getByText(/85 \/ 100 \(85 %\)/)).toBeInTheDocument();
    expect(screen.getByText("80 % consumido")).toBeInTheDocument();
  });

  it("crea un rango nuevo con Idempotency-Key e invalida el listado", async () => {
    listFiscalRangesMock.mockResolvedValue([]);
    createFiscalRangeMock.mockResolvedValue({ id: 2, document_type: "invoice", prefix: "FE", consumed: 0 });
    const user = userEvent.setup();

    renderWithProviders(<RangesPage />);

    await waitFor(() => expect(listFiscalRangesMock).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Nuevo rango" }));

    await user.type(screen.getByLabelText("Prefijo"), "FE");
    await user.type(screen.getByLabelText("Desde (número)"), "1");
    await user.type(screen.getByLabelText("Hasta (número)"), "1000");
    await user.type(screen.getByLabelText("Número de resolución"), "18760000002");
    await user.type(screen.getByLabelText("Fecha de resolución"), "2026-01-01");
    await user.type(screen.getByLabelText("Vigente desde"), "2026-01-01");
    await user.type(screen.getByLabelText("Vigente hasta"), "2026-12-31");

    await user.click(screen.getByRole("button", { name: "Crear rango" }));

    await waitFor(() => expect(createFiscalRangeMock).toHaveBeenCalledTimes(1));
    const [body, idempotencyKey] = createFiscalRangeMock.mock.calls[0];
    expect(body.store_id).toBe(1);
    expect(body.prefix).toBe("FE");
    expect(body.from_number).toBe(1);
    expect(body.to_number).toBe(1000);
    expect(typeof idempotencyKey).toBe("string");
  });
});
