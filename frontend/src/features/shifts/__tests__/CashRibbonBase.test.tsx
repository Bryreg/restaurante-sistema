import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import type { ShiftCurrent } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import { CashRibbon } from "../CashRibbon";

/**
 * El hueco de la base de respaldo (`baseSlot.ts`): con los paneles
 * enchufados y su función encendida, «Tomar de la base» y «Devolver a la
 * base» aparecen en «Más», abren su hoja, y `debeDevolver` enciende el
 * botón del momento. Es el contrato que el trabajo de la base cumple al
 * integrar: sólo reemplaza `BASE_SLOT`.
 */

vi.mock("../baseSlot", () => ({
  BASE_SLOT: {
    flag: "cash.reserve",
    tomar: ({ shiftId }: { shiftId: number }) => <p>panel-tomar-{shiftId}</p>,
    devolver: ({ shiftId }: { shiftId: number }) => <p>panel-devolver-{shiftId}</p>,
    debeDevolver: (shift: { id: number }) => shift.id === 42,
  },
}));

const { SHIFT } = vi.hoisted(() => ({
  SHIFT: { id: 42, cash_responsible: { id: 1, name: "Ana" }, is_stale: false, cash_over_threshold: false } satisfies ShiftCurrent,
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return { ...actual, getCurrentShift: vi.fn().mockResolvedValue(SHIFT) };
});

function cajero(features: Record<string, boolean>): Me {
  return {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: [] },
    employee: { id: 5, name: "Caro", role: "operator", can_charge: true },
    employee_expires_at: null,
    organization: { id: 1, name: "Organización de prueba" },
    features,
  } as Me;
}

describe("CashRibbon — hueco de la base de respaldo", () => {
  it("enchufada y encendida: está en «Más», pide «Devolver a la base» como aviso y abre su hoja", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CashRibbon />, { me: cajero({ "cash.reserve": true }), route: "/pos/mesas" });

    const nav = await screen.findByRole("navigation", { name: "Acciones de caja" });
    await user.click(within(nav).getByRole("button", { name: "Devolver a la base" }));
    expect(within(await screen.findByRole("dialog")).getByText("panel-devolver-42")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Volver a Mesas" }));

    await user.click(within(nav).getByRole("button", { name: "Más acciones de caja" }));
    const items = (await screen.findAllByRole("menuitem")).map((i) => i.textContent);
    expect(items).toContain("Tomar de la base");
    expect(items).toContain("Devolver a la base");
    await user.click(screen.getByRole("menuitem", { name: "Tomar de la base" }));
    expect(within(await screen.findByRole("dialog")).getByText("panel-tomar-42")).toBeInTheDocument();
  });

  it("con la función apagada no aparece nada de la base", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CashRibbon />, { me: cajero({}), route: "/pos/mesas" });

    const nav = await screen.findByRole("navigation", { name: "Acciones de caja" });
    expect(within(nav).queryByRole("button", { name: "Devolver a la base" })).not.toBeInTheDocument();
    await user.click(within(nav).getByRole("button", { name: "Más acciones de caja" }));
    const items = (await screen.findAllByRole("menuitem")).map((i) => i.textContent);
    expect(items).not.toContain("Tomar de la base");
  });
});
