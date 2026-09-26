/**
 * Consignar desde el POS (decisión del dueño, 2026-09-24): quien tiene la
 * caja consigna la plata de días anteriores que está en el cajón. Lo que se
 * prueba acá es lo que no se negocia:
 *
 * - el monto se PRECARGA con `remaining` del servidor, tal cual — nunca con
 *   una resta hecha en la pantalla — y del día más viejo al que le queda algo;
 * - el comprobante es obligatorio: sin foto no sale el POST;
 * - el POST lleva exactamente el contrato de `POST /deposits`, con su
 *   `Idempotency-Key`;
 * - el estado de cada consignación lo dice el servidor («Por confirmar»,
 *   «Confirmada», «Rechazada: motivo»).
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DepositOut, DrawerOut } from "@/api/banking";
import { renderWithProviders } from "@/test/utils";

import { DepositDrawerPanel } from "../DepositDrawerPanel";

const { getDepositDrawerMock, createPosDepositMock } = vi.hoisted(() => ({
  getDepositDrawerMock: vi.fn(),
  createPosDepositMock: vi.fn(),
}));

vi.mock("@/api/banking", async () => {
  const actual = await vi.importActual<typeof import("@/api/banking")>("@/api/banking");
  return { ...actual, getDepositDrawer: getDepositDrawerMock, createPosDeposit: createPosDepositMock };
});

// La mecánica de la cámara no es lo que se prueba: un stub que entrega un
// *data URL* fijo (mismo patrón que `banking/__tests__/CreateDepositDialog.test.tsx`).
vi.mock("@/components/PhotoCaptureField", () => ({
  PhotoCaptureField: ({
    onChange,
    onProcessingChange,
  }: {
    onChange: (dataUrl: string | null) => void;
    onProcessingChange?: (processing: boolean) => void;
  }) => (
    <>
      <button type="button" onClick={() => onChange("data:image/png;base64,xyz")}>
        Adjuntar comprobante (stub)
      </button>
      <button type="button" onClick={() => onProcessingChange?.(true)}>
        Empezar a procesar (stub)
      </button>
    </>
  ),
}));

const DRAWER: DrawerOut = {
  shift_id: 42,
  days: [
    // El más viejo ya se consignó entero: no se ofrece.
    { source_shift_id: 10, business_date: "2026-09-20", carried: 100_000, deposited_from_drawer: 100_000, remaining: 0 },
    { source_shift_id: 11, business_date: "2026-09-21", carried: 350_000, deposited_from_drawer: 150_000, remaining: 200_000 },
    { source_shift_id: 12, business_date: "2026-09-22", carried: 410_000, deposited_from_drawer: 0, remaining: 410_000 },
  ],
  deposits: [],
};

function deposit(overrides: Partial<DepositOut>): DepositOut {
  return {
    id: 1,
    amount: 150_000,
    status: "live",
    source: "pos",
    from_shift_id: 42,
    allocations: [{ shift_id: 11, amount: 150_000 }],
    needs_confirmation: true,
    confirmed_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  getDepositDrawerMock.mockReset();
  createPosDepositMock.mockReset();
});

describe("DepositDrawerPanel — consignar desde el POS", () => {
  it("precarga el monto con `remaining` del día más viejo que todavía tiene saldo", async () => {
    getDepositDrawerMock.mockResolvedValue(DRAWER);
    renderWithProviders(<DepositDrawerPanel shiftId={42} />);

    const amount = await screen.findByLabelText("Monto a consignar");
    expect(amount).toHaveValue("$ 200.000");
    // El día consignado entero no se ofrece; los otros dos sí, con lo que les queda.
    expect(screen.getByRole("button", { name: /lun 21 sep/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /mar 22 sep/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: /dom 20 sep/i })).not.toBeInTheDocument();
  });

  it("al elegir otro día, el monto se vuelve a precargar con lo que queda de ESE día", async () => {
    getDepositDrawerMock.mockResolvedValue(DRAWER);
    const user = userEvent.setup();
    renderWithProviders(<DepositDrawerPanel shiftId={42} />);

    await screen.findByLabelText("Monto a consignar");
    await user.click(screen.getByRole("button", { name: /mar 22 sep/i }));
    expect(screen.getByLabelText("Monto a consignar")).toHaveValue("$ 410.000");
  });

  it("sin foto del comprobante no se registra nada", async () => {
    getDepositDrawerMock.mockResolvedValue(DRAWER);
    const user = userEvent.setup();
    renderWithProviders(<DepositDrawerPanel shiftId={42} />);

    await screen.findByLabelText("Monto a consignar");
    await user.click(screen.getByRole("button", { name: "Registrar consignación" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/foto al comprobante/i);
    expect(createPosDepositMock).not.toHaveBeenCalled();
  });

  it("con foto, manda el contrato de POST /deposits con el día, el monto (editable), el banco y la clave de idempotencia", async () => {
    getDepositDrawerMock.mockResolvedValue(DRAWER);
    createPosDepositMock.mockResolvedValue(deposit({ id: 7, amount: 120_000 }));
    const user = userEvent.setup();
    renderWithProviders(<DepositDrawerPanel shiftId={42} />);

    const amount = await screen.findByLabelText("Monto a consignar");
    // Consignar en partes: el monto se puede cambiar.
    await user.clear(amount);
    await user.type(amount, "120000");
    await user.type(screen.getByLabelText("Banco"), "Bancolombia");
    await user.type(screen.getByLabelText("Referencia (opcional)"), "AB-123");
    await user.click(screen.getByRole("button", { name: "Adjuntar comprobante (stub)" }));
    await user.click(screen.getByRole("button", { name: "Registrar consignación" }));

    await waitFor(() => expect(createPosDepositMock).toHaveBeenCalledTimes(1));
    const [body, key] = createPosDepositMock.mock.calls[0] ?? [];
    expect(body).toEqual({
      source_shift_id: 11,
      amount: 120_000,
      bank_name: "Bancolombia",
      bank_reference: "AB-123",
      receipt_photo: "data:image/png;base64,xyz",
      note: null,
    });
    expect(typeof key).toBe("string");
    expect(key).not.toBe("");
    // Después de registrar se vuelve a pedir el cajón: lo que queda lo dice el servidor.
    await waitFor(() => expect(getDepositDrawerMock).toHaveBeenCalledTimes(2));
  });

  it("mientras la foto se procesa no se puede registrar", async () => {
    getDepositDrawerMock.mockResolvedValue(DRAWER);
    const user = userEvent.setup();
    renderWithProviders(<DepositDrawerPanel shiftId={42} />);

    await screen.findByLabelText("Monto a consignar");
    await user.click(screen.getByRole("button", { name: "Empezar a procesar (stub)" }));
    const submit = screen.getByRole("button", { name: "Procesando foto…" });
    expect(submit).toBeDisabled();
    expect(createPosDepositMock).not.toHaveBeenCalled();
  });

  it("lista las consignaciones del turno con el estado que dice el servidor", async () => {
    getDepositDrawerMock.mockResolvedValue({
      ...DRAWER,
      deposits: [
        deposit({ id: 1, amount: 150_000 }),
        deposit({ id: 2, amount: 50_000, needs_confirmation: false, confirmed_at: "2026-09-24T15:00:00Z" }),
        deposit({
          id: 3,
          amount: 30_000,
          status: "reversed",
          needs_confirmation: false,
          reversed_reason: "El comprobante no se lee",
        }),
      ],
    });
    renderWithProviders(<DepositDrawerPanel shiftId={42} />);

    expect(await screen.findByText("Consignaciones de este turno")).toBeInTheDocument();
    expect(screen.getByText("Por confirmar")).toBeInTheDocument();
    expect(screen.getByText("Confirmada")).toBeInTheDocument();
    expect(screen.getByText("Rechazada: El comprobante no se lee")).toBeInTheDocument();
    expect(screen.getAllByText("lun 21 sep").length).toBeGreaterThan(0);
  });

  it("sin días con saldo en el cajón no ofrece el formulario", async () => {
    getDepositDrawerMock.mockResolvedValue({ shift_id: 42, days: [DRAWER.days[0]!], deposits: [] });
    renderWithProviders(<DepositDrawerPanel shiftId={42} />);

    expect(await screen.findByText("No hay plata de días anteriores para consignar")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Registrar consignación" })).not.toBeInTheDocument();
  });

  it("con bancos usados antes, el último viene elegido y se cambia con un toque (o se escribe otro)", async () => {
    getDepositDrawerMock.mockResolvedValue({ ...DRAWER, recent_banks: ["Davivienda", "Bancolombia"] });
    createPosDepositMock.mockResolvedValue(deposit({ id: 8, amount: 120_000 }));
    const user = userEvent.setup();
    renderWithProviders(<DepositDrawerPanel shiftId={42} />);

    const davivienda = await screen.findByRole("button", { name: "Davivienda" });
    expect(davivienda).toHaveAttribute("aria-pressed", "true");
    // No hay que teclear el banco: ya está elegido.
    expect(screen.queryByRole("textbox", { name: /banco/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Bancolombia" }));
    expect(screen.getByRole("button", { name: "Bancolombia" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Adjuntar comprobante (stub)" }));
    await user.click(screen.getByRole("button", { name: "Registrar consignación" }));
    await waitFor(() => expect(createPosDepositMock).toHaveBeenCalledTimes(1));
    expect(createPosDepositMock.mock.calls[0]?.[0]).toMatchObject({ bank_name: "Bancolombia" });

    await user.click(screen.getByRole("button", { name: "Otro banco" }));
    expect(screen.getByLabelText("Nombre del otro banco")).toHaveValue("");
  });
});
