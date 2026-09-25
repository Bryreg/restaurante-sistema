import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import type { ShiftCurrent, ShiftSummary } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import ShiftPage from "../ShiftPage";

/**
 * El panel único del turno (2026-09-25): la grilla de botones grandes, la
 * hoja que abre cada uno, el deep link `?accion=` y el cierre aparte.
 *
 * Los paneles de cada acción se reemplazan por dobles: acá se prueba desde
 * dónde se llega a cada uno, no lo que hacen adentro (eso lo prueban sus
 * propios tests, que no cambiaron). El doble del cierre llama `onClosed`
 * como el real, para probar que la tarjeta de turno cerrado sigue
 * apareciendo con «A consignar».
 */

const { SHIFT, SUMMARY } = vi.hoisted(() => ({
  SHIFT: {
    id: 42,
    business_date: "2026-09-14",
    opened_at: "2026-09-14T13:00:00Z",
    cash_responsible: { id: 1, name: "Ana" },
    roster: [
      { employee_id: 1, employee_name: "Ana", in_at: "2026-09-14T13:00:00Z", out_at: null },
      { employee_id: 2, employee_name: "Beto", in_at: "2026-09-14T13:05:00Z", out_at: "2026-09-14T15:00:00Z" },
    ],
    is_stale: false,
    cash_over_threshold: false,
    // `expected_cash` AUSENTE: cierre a ciegas, el servidor no lo manda.
  } satisfies ShiftCurrent,
  SUMMARY: {
    id: 42,
    business_date: "2026-09-14",
    status: "open",
    opened_at: "2026-09-14T13:00:00Z",
    cash_responsible: { id: 1, name: "Ana" },
    opening_cash_total: 200_000,
    cash_reserve: 50_000,
    roster: [],
    movements: [],
    swaps: [],
    pickups: [],
    handovers: [],
  } satisfies ShiftSummary,
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return {
    ...actual,
    getCurrentShift: vi.fn().mockResolvedValue(SHIFT),
    getShiftSummary: vi.fn().mockResolvedValue(SUMMARY),
  };
});

vi.mock("../RosterPanel", () => ({ RosterPanel: () => <p>panel-entrada</p> }));
vi.mock("../MovementsPanel", () => ({ MovementsPanel: () => <p>panel-movimientos</p> }));
vi.mock("../CashSwapPanel", () => ({ CashSwapPanel: () => <p>panel-cambio</p> }));
vi.mock("../PickupsPanel", () => ({ PickupsPanel: () => <p>panel-retiros</p> }));
vi.mock("../DeliverySettlementPanel", () => ({ DeliverySettlementPanel: () => <p>panel-domicilios</p> }));
vi.mock("../DepositDrawerPanel", () => ({ DepositDrawerPanel: () => <p>panel-consignar</p> }));
vi.mock("../HandoverPanel", () => ({ HandoverPanel: () => <p>panel-relevo</p> }));
vi.mock("../CloseWizard", () => ({
  CloseWizard: ({ onClosed }: { onClosed: (r: { to_deposit: number; closes_day: boolean }) => void }) => (
    <button type="button" onClick={() => onClosed({ to_deposit: 1_234_500, closes_day: false })}>
      asistente-a-ciegas
    </button>
  ),
}));
vi.mock("../SingleStepCloseForm", () => ({
  SingleStepCloseForm: () => <p>cierre-en-un-paso</p>,
}));

const TODAS = {
  "cash.swaps": true,
  "cash.pickups": true,
  "pos.delivery": true,
  "money.deposits": true,
  "cash.handovers": true,
};

function deviceMe(features: Record<string, boolean>): Me {
  return {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: [] },
    employee: { id: 1, name: "Ana", role: "operator", can_charge: false },
    employee_expires_at: null,
    organization: { id: 1, name: "Organización de prueba" },
    features,
  };
}

/** Los rótulos de la grilla, en orden (el nombre accesible de cada botón es su rótulo). */
async function rotulosDeLaGrilla(): Promise<string[]> {
  const seccion = (await screen.findByRole("heading", { name: "Acciones del turno" })).closest("section");
  return within(seccion as HTMLElement)
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? "");
}

describe("ShiftPage — panel único: la grilla respeta los flags", () => {
  it("con todo encendido muestra las siete acciones, y el cierre aparte", async () => {
    renderWithProviders(<ShiftPage />, { me: deviceMe(TODAS) });

    expect(await rotulosDeLaGrilla()).toEqual([
      "Entrada / Salida",
      "Movimientos",
      "Cambio",
      "Retiros",
      "Domicilios",
      "Consignar",
      "Relevo",
    ]);
    // «Cerrar turno» no es parte de la grilla.
    expect(screen.getByRole("button", { name: /Cerrar turno/ })).toBeInTheDocument();
  });

  it("con todo apagado quedan sólo las acciones núcleo (entrada/salida y movimientos) y el cierre", async () => {
    renderWithProviders(<ShiftPage />, { me: deviceMe({}) });

    expect(await rotulosDeLaGrilla()).toEqual(["Entrada / Salida", "Movimientos"]);
    expect(screen.getByRole("button", { name: /Cerrar turno/ })).toBeInTheDocument();
  });

  it("muestra el equipo en turno: quién está adentro y quién ya salió", async () => {
    renderWithProviders(<ShiftPage />, { me: deviceMe({}) });

    const equipo = (await screen.findByRole("heading", { name: "Equipo en turno" })).closest("section") as HTMLElement;
    expect(within(equipo).getByRole("listitem").textContent).toContain("Ana");
    expect(within(equipo).getByText(/Ya salieron: Beto/)).toBeInTheDocument();
  });
});

describe("ShiftPage — cada botón abre su panel en una hoja", () => {
  const CASOS: Array<[string, string]> = [
    ["Entrada / Salida", "panel-entrada"],
    ["Movimientos", "panel-movimientos"],
    ["Cambio", "panel-cambio"],
    ["Retiros", "panel-retiros"],
    ["Domicilios", "panel-domicilios"],
    ["Consignar", "panel-consignar"],
    ["Relevo", "panel-relevo"],
  ];

  it.each(CASOS)("«%s» abre %s, con su título, y «Resumen» vuelve al panel", async (rotulo, panel) => {
    const user = userEvent.setup();
    renderWithProviders(<ShiftPage />, { me: deviceMe(TODAS) });

    await user.click(await screen.findByRole("button", { name: rotulo }));

    const hoja = await screen.findByRole("dialog", { name: rotulo });
    expect(within(hoja).getByText(panel)).toBeInTheDocument();

    await user.click(within(hoja).getByRole("button", { name: /resumen/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("ShiftPage — deep link ?accion=", () => {
  it("?accion=consignar abre Consignar directo", async () => {
    renderWithProviders(<ShiftPage />, {
      me: deviceMe({ "money.deposits": true }),
      route: "/pos/turno?accion=consignar",
    });

    const hoja = await screen.findByRole("dialog", { name: "Consignar" });
    expect(within(hoja).getByText("panel-consignar")).toBeInTheDocument();
  });

  it("?accion=consignar con money.deposits apagada se ignora", async () => {
    renderWithProviders(<ShiftPage />, {
      me: deviceMe({ "money.deposits": false }),
      route: "/pos/turno?accion=consignar",
    });

    await rotulosDeLaGrilla();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("panel-consignar")).not.toBeInTheDocument();
  });

  it("?accion=relevo con cash.handovers apagado se ignora", async () => {
    renderWithProviders(<ShiftPage />, {
      me: deviceMe({ "cash.handovers": false }),
      route: "/pos/turno?accion=relevo",
    });

    await rotulosDeLaGrilla();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("una acción desconocida se ignora", async () => {
    renderWithProviders(<ShiftPage />, { me: deviceMe(TODAS), route: "/pos/turno?accion=inventada" });

    await rotulosDeLaGrilla();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([
    ["movimientos", "Movimientos", "panel-movimientos"],
    ["cambio", "Cambio", "panel-cambio"],
    ["retiros", "Retiros", "panel-retiros"],
    ["domicilios", "Domicilios", "panel-domicilios"],
    ["relevo", "Relevo", "panel-relevo"],
  ])("?accion=%s abre %s", async (clave, titulo, panel) => {
    renderWithProviders(<ShiftPage />, { me: deviceMe(TODAS), route: `/pos/turno?accion=${clave}` });

    const hoja = await screen.findByRole("dialog", { name: titulo });
    expect(within(hoja).getByText(panel)).toBeInTheDocument();
  });
});

describe("ShiftPage — el cierre, aparte", () => {
  it("con cash.blind_close apagada abre el cierre en un paso", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShiftPage />, { me: deviceMe({ "cash.blind_close": false }) });

    await user.click(await screen.findByRole("button", { name: /Cerrar turno/ }));
    const hoja = await screen.findByRole("dialog", { name: "Cierre" });
    expect(within(hoja).getByText("cierre-en-un-paso")).toBeInTheDocument();
    expect(within(hoja).queryByText("asistente-a-ciegas")).not.toBeInTheDocument();
  });

  it("?accion=cierre con cash.blind_close abre el asistente a ciegas, y al cerrar queda la tarjeta con «A consignar»", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShiftPage />, {
      me: deviceMe({ "cash.blind_close": true }),
      route: "/pos/turno?accion=cierre",
    });

    const hoja = await screen.findByRole("dialog", { name: "Cierre" });
    // El estado del turno no revela el esperado: el servidor no lo mandó.
    const esperado = screen.getAllByText("Esperado").find((e) => !hoja.contains(e)) as HTMLElement;
    expect(esperado.parentElement?.textContent).toContain("—");

    await user.click(within(hoja).getByRole("button", { name: "asistente-a-ciegas" }));

    // La tarjeta del turno cerrado reemplaza la página entera, hoja incluida.
    await waitFor(() => expect(screen.getByText("A consignar")).toBeInTheDocument());
    expect((screen.getByText("A consignar").closest("div") as HTMLElement).textContent).toMatch(/1\.234\.500/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Acciones del turno" })).not.toBeInTheDocument();

    // Al acusar recibo («Listo», porque el doble no cerró el turno en el
    // servidor) vuelve el panel SIN reabrir el cierre: el `?accion=cierre`
    // se limpió.
    await user.click(screen.getByRole("button", { name: "Listo" }));
    await screen.findByRole("heading", { name: "Acciones del turno" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
