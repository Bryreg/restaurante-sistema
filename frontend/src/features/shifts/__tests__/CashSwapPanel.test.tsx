import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/utils";

import { CashSwapPanel } from "../CashSwapPanel";

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return { ...actual, previewCashSwap: vi.fn(), createCashSwap: vi.fn() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { previewCashSwap, createCashSwap } = await import("@/api/shifts");

beforeEach(() => {
  vi.mocked(previewCashSwap).mockReset();
  vi.mocked(createCashSwap).mockReset().mockResolvedValue({ id: 1, amount: 100000 });
});

describe("CashSwapPanel — la hoja «Cambio» (handoff PosMesas)", () => {
  it("el cuadre «Entra · sale · cuadra» son las sumas del servidor, y recién ahí se registra", async () => {
    // Cifras que la pantalla no podría sacar sumando lo tocado: si aparecen
    // es porque se pintó lo que dijo el servidor.
    vi.mocked(previewCashSwap).mockImplementation(async (body) =>
      body.out.length > 0
        ? { in_total: 100001, out_total: 100001, balanced: true }
        : { in_total: 100001, out_total: 0, balanced: false },
    );
    const user = userEvent.setup();
    renderWithProviders(<CashSwapPanel shiftId={9} />);

    const registrar = screen.getByRole("button", { name: "Registrar cambio" });
    expect(registrar).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /entra un billete de \$ 100\.000/i }));
    expect(screen.getByText("1 billete")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /una más de \$ 50\.000/i }));
    await user.click(screen.getByRole("button", { name: /una más de \$ 50\.000/i }));

    expect(await screen.findByText(/entra \$ 100\.001 · sale \$ 100\.001 · cuadra/i)).toBeInTheDocument();
    expect(previewCashSwap).toHaveBeenLastCalledWith({
      in: [{ value: 100000, count: 1 }],
      out: [{ value: 50000, count: 2 }],
    });
    await waitFor(() => expect(registrar).toBeEnabled());

    await user.click(registrar);
    await waitFor(() => expect(createCashSwap).toHaveBeenCalledTimes(1));
    expect(createCashSwap).toHaveBeenCalledWith(9, {
      out: { denominations: [{ value: 50000, count: 2 }], total: 100001 },
      in: { denominations: [{ value: 100000, count: 1 }], total: 100001 },
    });
  });

  it("si el servidor dice que no cuadra, lo dice y no deja registrar", async () => {
    vi.mocked(previewCashSwap).mockResolvedValue({ in_total: 100000, out_total: 50000, balanced: false });
    const user = userEvent.setup();
    renderWithProviders(<CashSwapPanel shiftId={9} />);

    await user.click(screen.getByRole("button", { name: /entra un billete de \$ 100\.000/i }));
    await user.click(screen.getByRole("button", { name: /una más de \$ 50\.000/i }));

    expect(await screen.findByText(/no cuadra/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Registrar cambio" })).toBeDisabled();
  });
});
