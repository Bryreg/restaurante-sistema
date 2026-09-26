import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import type { StaffRequest } from "@/api/requests";
import type { ShiftCurrent } from "@/api/shifts";
import { TablesPage } from "@/features/orders/TablesPage";
import { buildTablesStatus } from "@/features/orders/__tests__/fixtures";
import { renderWithProviders } from "@/test/utils";

/**
 * La cinta de caja en Mesas: la ve sólo quien puede manejar la caja, cada
 * acción abre su hoja ENCIMA de Mesas (el mapa sigue montado), el botón «del
 * momento» sigue al aviso del turno, y nunca se ve una cifra de plata.
 *
 * Los paneles se reemplazan por dobles, como en `ShiftPageAcciones.test`:
 * acá se prueba desde dónde se llega, no lo que hacen adentro.
 */

const mocks = vi.hoisted(() => ({
  getCurrentShift: vi.fn(),
  listPendingDeliveryCash: vi.fn(),
  listMyRequests: vi.fn(),
  listTablesStatus: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return {
    ...actual,
    getCurrentShift: mocks.getCurrentShift,
    listPendingDeliveryCash: mocks.listPendingDeliveryCash,
  };
});
vi.mock("@/api/requests", async () => {
  const actual = await vi.importActual<typeof import("@/api/requests")>("@/api/requests");
  return { ...actual, listMyRequests: mocks.listMyRequests };
});
vi.mock("@/api/orders", async () => {
  const actual = await vi.importActual<typeof import("@/api/orders")>("@/api/orders");
  return { ...actual, listTablesStatus: mocks.listTablesStatus };
});
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock("../RosterPanel", () => ({ RosterPanel: () => <p>panel-entrada</p> }));
vi.mock("../MovementsPanel", () => ({ MovementsPanel: () => <p>panel-movimientos</p> }));
vi.mock("../CashSwapPanel", () => ({ CashSwapPanel: () => <p>panel-cambio</p> }));
vi.mock("../PickupsPanel", () => ({ PickupsPanel: () => <p>panel-retiros</p> }));
vi.mock("../DeliverySettlementPanel", () => ({ DeliverySettlementPanel: () => <p>panel-domicilios</p> }));
vi.mock("../DepositDrawerPanel", () => ({ DepositDrawerPanel: () => <p>panel-consignar</p> }));
vi.mock("../HandoverPanel", () => ({ HandoverPanel: () => <p>panel-relevo</p> }));
vi.mock("@/features/requests", () => ({ RequestsPanel: () => <p>panel-solicitudes</p> }));
vi.mock("../CloseWizard", () => ({
  CloseWizard: ({ onClosed }: { onClosed: (r: { to_deposit: number; closes_day: boolean }) => void }) => (
    <button type="button" onClick={() => onClosed({ to_deposit: 1_234_500, closes_day: false })}>
      asistente-a-ciegas
    </button>
  ),
}));

const SHIFT: ShiftCurrent = {
  id: 42,
  business_date: "2026-09-14",
  cash_responsible: { id: 1, name: "Ana" },
  is_stale: false,
  cash_over_threshold: false,
};

const TODAS = {
  "pos.tables": true,
  "cash.swaps": true,
  "cash.pickups": true,
  "pos.delivery": true,
  "money.deposits": true,
  "cash.handovers": true,
  "pos.requests": true,
  "cash.blind_close": true,
};

function me(employee: { id: number; role?: string; can_charge?: boolean }, features: Record<string, boolean> = TODAS): Me {
  return {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: ["dine_in"] },
    employee: { name: "Persona", role: "operator", can_charge: false, ...employee },
    employee_expires_at: null,
    organization: { id: 1, name: "Organización de prueba" },
    features,
  } as Me;
}

const CAJERO = me({ id: 5, can_charge: true });
const MESERO = me({ id: 9, can_charge: false });

function renderMesas(persona: Me, route = "/pos/mesas") {
  return renderWithProviders(<TablesPage />, { me: persona, route });
}

async function cinta(): Promise<HTMLElement> {
  return screen.findByRole("navigation", { name: "Acciones de caja" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentShift.mockResolvedValue(SHIFT);
  mocks.listPendingDeliveryCash.mockResolvedValue({ couriers: [] });
  mocks.listMyRequests.mockResolvedValue([]);
  mocks.listTablesStatus.mockResolvedValue(buildTablesStatus());
});

describe("CashRibbon — quién la ve", () => {
  it("quien cobra la ve, con Domicilios, Cambio, Gasto / Ingreso, el del momento y «Más»", async () => {
    renderMesas(CAJERO);

    const nav = await cinta();
    const botones = within(nav)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(botones).toEqual(["Domicilios", "Cambio", "Gasto / Ingreso", "Más acciones de caja"]);
    // Sin aviso, el lugar del momento queda quieto.
    expect(within(nav).getByText("Sin avisos")).toBeInTheDocument();
  });

  it("el mesero sin permiso de cobrar no la ve", async () => {
    renderMesas(MESERO);

    await screen.findByText("Mesa 1");
    await waitFor(() => expect(mocks.getCurrentShift).toHaveBeenCalled());
    expect(screen.queryByRole("navigation", { name: "Acciones de caja" })).not.toBeInTheDocument();
  });

  it("el responsable de la caja del turno la ve aunque no tenga permiso de cobrar", async () => {
    renderMesas(me({ id: 1, can_charge: false }));
    expect(await cinta()).toBeInTheDocument();
  });

  it("sin turno abierto no hay cinta", async () => {
    mocks.getCurrentShift.mockResolvedValue(null);
    renderMesas(CAJERO);

    await screen.findByText("Mesa 1");
    await waitFor(() => expect(mocks.getCurrentShift).toHaveBeenCalled());
    expect(screen.queryByRole("navigation", { name: "Acciones de caja" })).not.toBeInTheDocument();
  });

  it("una función apagada no deja hueco (sin domicilios ni cambio)", async () => {
    renderMesas(me({ id: 5, can_charge: true }, { "pos.tables": true }));

    const nav = await cinta();
    expect(within(nav).queryByRole("button", { name: "Domicilios" })).not.toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: "Cambio" })).not.toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Gasto / Ingreso" })).toBeInTheDocument();
  });
});

describe("CashRibbon — cada acción abre su hoja encima de Mesas", () => {
  it.each([
    ["Domicilios", "panel-domicilios"],
    ["Cambio", "panel-cambio"],
    ["Gasto / Ingreso", "panel-movimientos"],
  ])("«%s» abre %s sin salir de Mesas, y «Mesas» la cierra", async (rotulo, panel) => {
    const user = userEvent.setup();
    renderMesas(CAJERO);

    await user.click(within(await cinta()).getByRole("button", { name: rotulo }));

    const hoja = await screen.findByRole("dialog");
    expect(within(hoja).getByText(panel)).toBeInTheDocument();
    expect(within(hoja).getByRole("heading", { name: rotulo })).toBeInTheDocument();
    // No se navegó: el mapa de mesas sigue montado debajo de la hoja.
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByText("Mesa 1")).toBeInTheDocument();

    await user.click(within(hoja).getByRole("button", { name: "Volver a Mesas" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Mesa 1")).toBeInTheDocument();
  });

  it("«Más» trae el resto, en orden y con el cierre al final; cada una abre su hoja", async () => {
    const user = userEvent.setup();
    renderMesas(CAJERO);

    await user.click(within(await cinta()).getByRole("button", { name: "Más acciones de caja" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "Retiros",
      "Consignar",
      "Relevo",
      "Solicitudes",
      "Entrada / Salida",
      "Cierre",
    ]);

    await user.click(screen.getByRole("menuitem", { name: "Relevo" }));
    const hoja = await screen.findByRole("dialog");
    expect(within(hoja).getByText("panel-relevo")).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("el deep link /pos/mesas?accion=retiros abre Retiros encima de Mesas", async () => {
    renderMesas(CAJERO, "/pos/mesas?accion=retiros");

    const hoja = await screen.findByRole("dialog");
    expect(within(hoja).getByText("panel-retiros")).toBeInTheDocument();
    expect(await screen.findByText("Mesa 1")).toBeInTheDocument();
  });

  it("una acción apagada no se abre ni por la URL", async () => {
    renderMesas(me({ id: 5, can_charge: true }, { "pos.tables": true }), "/pos/mesas?accion=retiros");

    await cinta();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cerrar la caja desde la cinta muestra «Turno cerrado» con lo que se consigna, y vuelve a Mesas", async () => {
    const user = userEvent.setup();
    renderMesas(CAJERO, "/pos/mesas?accion=cierre");

    await user.click(await screen.findByRole("button", { name: "asistente-a-ciegas" }));
    mocks.getCurrentShift.mockResolvedValue(null);

    expect(await screen.findByText("Turno cerrado.")).toBeInTheDocument();
    expect(screen.getByText("A consignar")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Volver a Mesas" }));
    await waitFor(() => expect(screen.queryByText("Turno cerrado.")).not.toBeInTheDocument());
    expect(screen.getByText("Mesa 1")).toBeInTheDocument();
  });
});

describe("CashRibbon — el botón del momento", () => {
  it("efectivo sobre el umbral → «Retiro sugerido», que abre Retiros", async () => {
    mocks.getCurrentShift.mockResolvedValue({ ...SHIFT, cash_over_threshold: true });
    const user = userEvent.setup();
    renderMesas(CAJERO);

    const boton = await within(await cinta()).findByRole("button", { name: "Retiro sugerido" });
    expect(boton).toHaveAccessibleDescription("El efectivo del cajón pasó el umbral de retiro");
    await user.click(boton);
    expect(within(await screen.findByRole("dialog")).getByText("panel-retiros")).toBeInTheDocument();
  });

  it("sencilla aprobada → «Llegó la sencilla», que abre Solicitudes; y Solicitudes lleva su contador en «Más»", async () => {
    mocks.listMyRequests.mockResolvedValue([{ id: 3, kind: "change", status: "approved" } as StaffRequest]);
    const user = userEvent.setup();
    renderMesas(CAJERO);

    const nav = await cinta();
    expect(await within(nav).findByRole("button", { name: "Más acciones de caja, 1 por atender" })).toBeInTheDocument();
    await user.click(within(nav).getByRole("button", { name: "Llegó la sencilla" }));
    expect(within(await screen.findByRole("dialog")).getByText("panel-solicitudes")).toBeInTheDocument();
  });

  it("domiciliarios con efectivo por liquidar → contador en «Domicilios»", async () => {
    mocks.listPendingDeliveryCash.mockResolvedValue({
      couriers: [
        { courier_employee_id: 1, total: 50_000 },
        { courier_employee_id: 2, total: 20_000 },
      ],
      total: 70_000,
    });
    renderMesas(CAJERO);

    const nav = await cinta();
    expect(await within(nav).findByRole("button", { name: "Domicilios, 2 por atender" })).toBeInTheDocument();
    // Cuenta personas, no plata.
    expect(nav.textContent).not.toMatch(/70|50\.000|\$/);
  });

  it("nunca muestra plata: ni el esperado, aunque el servidor lo mandara", async () => {
    mocks.getCurrentShift.mockResolvedValue({ ...SHIFT, expected_cash: 987_654, cash_over_threshold: true });
    renderMesas(CAJERO);

    const nav = await cinta();
    await within(nav).findByRole("button", { name: "Retiro sugerido" });
    expect(nav.textContent).not.toMatch(/987|\$/);
  });
});
