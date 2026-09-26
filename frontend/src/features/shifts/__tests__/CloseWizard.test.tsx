import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import type { ClosePrecheck, CloseCountResult, CloseReview, ShiftTips } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import { CloseWizard } from "../CloseWizard";

const { closeCountMock, getCloseReviewMock, confirmCloseMock, getShiftTipsMock, getClosePrecheckMock } = vi.hoisted(() => ({
  closeCountMock: vi.fn(),
  getCloseReviewMock: vi.fn(),
  confirmCloseMock: vi.fn(),
  getShiftTipsMock: vi.fn(),
  getClosePrecheckMock: vi.fn(),
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return {
    ...actual,
    closeCount: closeCountMock,
    getCloseReview: getCloseReviewMock,
    confirmClose: confirmCloseMock,
    getShiftTips: getShiftTipsMock,
    getClosePrecheck: getClosePrecheckMock,
  };
});

const FIRST_REVIEW: CloseReview = {
  count_id: 7,
  expected: 250_000,
  difference: -5_000,
  equation: { base: 200_000, cash_sales: 60_000, incomes: 0, expenses: 10_000, pickups: 0 },
  card: { registered: 0, counted: 0, difference: 0 },
  transfer: { registered: 0, counted: 0, difference: 0 },
  requires_cause: true,
  requires_identified_cause: false,
  is_critical: false,
  closes_day_suggested: false,
};

// Sin causa obligatoria: esta review sirve para probar el camino de
// DIFFERENCE_CHANGED sin depender de abrir un `<Select>` de base-ui en
// jsdom (una interacción aparte, ya cubierta por otros agentes/tests).
/** El paso 0 sin nada pendiente ni conteo sellado: arranca en el paso 1. */
const PRECHECK_CLEAR: ClosePrecheck = {
  shift_id: 1,
  open_orders: 0,
  delivery_pending_payments: 0,
  delivery_pending_couriers: 0,
  card_total_required: false,
  transfer_total_required: false,
  photo_required: false,
  sealed_count: null,
  items: [],
};

const NO_CAUSE_REVIEW: CloseReview = { ...FIRST_REVIEW, difference: 0, requires_cause: false };
const CHANGED_REVIEW: CloseReview = { ...NO_CAUSE_REVIEW, difference: -8_000 };

describe("CloseWizard — cierre a ciegas en tres pasos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClosePrecheckMock.mockResolvedValue(PRECHECK_CLEAR);
    getShiftTipsMock.mockResolvedValue({ cash_out: 12_345 } satisfies ShiftTips);
  });

  it("iteración 3 (H-8): pinta el cash_out de GET /shifts/{id}/tips como referencia, sin recalcularlo", async () => {
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue(FIRST_REVIEW);

    renderWithProviders(<CloseWizard shiftId={1} onClosed={() => {}} />, { me: { kind: "device", features: {} } });

    await waitFor(() => expect(getShiftTipsMock).toHaveBeenCalledWith(1));
    // El monto que llega de `cash_out` se pinta tal cual (formatCOP de 12.345), no recalculado.
    await waitFor(() => expect(screen.getByText(/12\.345/)).toBeInTheDocument());
    // El rótulo deja claro que es una referencia, no un dato que se use para calcular nada.
    expect(screen.getByText(/Referencia del sistema/)).toBeInTheDocument();
  });

  it("el paso 1 no muestra el esperado ni llama a la revisión antes de tener count_id", async () => {
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue(FIRST_REVIEW);

    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} onClosed={() => {}} />, { me: { kind: "device", features: {} } });

    // La palabra "esperado" puede aparecer en el texto explicativo del paso
    // 1 ("sin mirar lo esperado"); lo que nunca debe existir es la ETIQUETA
    // con la cifra, que en el paso 2 es un elemento cuyo texto es
    // exactamente "Esperado".
    await screen.findByRole("button", { name: /confirmar el conteo y continuar/i });
    expect(screen.queryByText(/^esperado$/i)).not.toBeInTheDocument();
    expect(getCloseReviewMock).not.toHaveBeenCalled();

    // Y la comprobación que de verdad importa: **ninguna cifra** del cuadre
    // en pantalla. La etiqueta era un sustituto del valor, y desde que el
    // paso 1 dibuja los renglones tapados (`DesgloseTapado`) el sustituto
    // dejó de alcanzar: los rótulos ahora SÍ están a la vista, con `•••••`
    // en lugar del número. Lo que no puede estar es el número.
    //
    // Se miran el esperado, la diferencia y los cinco sumandos: con cuatro
    // de los cinco se despeja el quinto, así que tapar sólo el total no
    // sirve de nada.
    //
    // El teclado de denominaciones queda FUERA del pajar, y no por
    // comodidad: sus rótulos son los valores de los billetes colombianos
    // ($100.000, $50.000 … $5.000), que son constantes de la moneda y
    // colisionan con cifras del cuadre por pura coincidencia numérica. Lo
    // que se vigila es el resto de la pantalla, que es donde una fuga sería
    // una fuga.
    const copia = document.body.cloneNode(true) as HTMLElement
    for (const campo of copia.querySelectorAll("fieldset")) {
      if (/efectivo contado|denominaciones/i.test(campo.querySelector("legend")?.textContent ?? "")) {
        campo.remove()
      }
    }
    const pajar = copia.textContent ?? ""

    const prohibidas = [
      FIRST_REVIEW.expected,
      FIRST_REVIEW.difference,
      ...Object.values(FIRST_REVIEW.equation ?? {}),
    ].filter((valor): valor is number => typeof valor === "number" && valor !== 0)
    for (const valor of prohibidas) {
      const conSeparadores = new Intl.NumberFormat("es-CO").format(Math.abs(valor))
      expect(
        pajar,
        `el paso 1 del cierre a ciegas está mostrando ${conSeparadores}, que es una cifra ` +
          `del cuadre: quien cuenta no puede ver ni el esperado ni ninguno de sus sumandos`,
      ).not.toContain(conSeparadores)
    }

    await user.click(await screen.findByRole("button", { name: /continuar/i }));

    await waitFor(() => expect(closeCountMock).toHaveBeenCalledTimes(1));
    // Recién después de tener `count_id` puede dispararse la revisión.
    await waitFor(() => expect(getCloseReviewMock).toHaveBeenCalledWith(1, 7));
    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());
  });

  it("ante 400 DIFFERENCE_CHANGED vuelve al paso 2 con la review nueva", async () => {
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue(NO_CAUSE_REVIEW);
    confirmCloseMock.mockRejectedValueOnce(
      new ApiError(400, "DIFFERENCE_CHANGED", "La diferencia cambió", { review: CHANGED_REVIEW }),
    );

    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} onClosed={() => {}} />, { me: { kind: "device", features: {} } });

    await user.click(await screen.findByRole("button", { name: /continuar/i }));
    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());

    // Paso 2 → paso 3. Sin diferencia (0) no exige causa: se puede confirmar directo.
    await user.click(await screen.findByRole("button", { name: /continuar/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /confirmar cierre/i })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /confirmar cierre/i }));

    await waitFor(() => expect(confirmCloseMock).toHaveBeenCalledTimes(1));
    // Vuelve al paso 2 con la diferencia de la review NUEVA, no la vieja.
    await waitFor(() => expect(screen.getByText(/-8\.000|8\.000/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /confirmar cierre/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Lo que encontró la demo de un día de venta
// ---------------------------------------------------------------------------

describe("CloseWizard — el lote del datáfono y las comandas abiertas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClosePrecheckMock.mockResolvedValue(PRECHECK_CLEAR);
    getShiftTipsMock.mockResolvedValue({ cash_out: 0 } satisfies ShiftTips);
  });

  const conTarjeta: CloseReview = {
    ...NO_CAUSE_REVIEW,
    card: { registered: 126_741, sales: 116_000, tips: 10_741, counted: 126_741, difference: 0 },
  };

  it("muestra de qué se compone lo que tiene que marcar el datáfono", async () => {
    // El defecto: el cierre comparaba contra la venta sola, así que todo
    // turno con propinas de tarjeta descuadraba por el monto exacto de las
    // propinas. Ahora el esperado las incluye — y se dice de dónde sale,
    // para que el número no parezca inventado.
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue(conTarjeta);

    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} onClosed={() => {}} />, { me: { kind: "device", features: {} } });
    await user.click(await screen.findByRole("button", { name: /continuar/i }));

    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());
    expect(screen.getByText(/Registrado = venta .*116\.000.* propina .*10\.741/)).toBeInTheDocument();
  });

  it("sin propinas de tarjeta no agrega la línea de composición", async () => {
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue(NO_CAUSE_REVIEW);

    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} onClosed={() => {}} />, { me: { kind: "device", features: {} } });
    await user.click(await screen.findByRole("button", { name: /continuar/i }));

    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());
    expect(screen.queryByText(/Registrado = venta/)).not.toBeInTheDocument();
  });

  it("ofrece trasladar las comandas abiertas y lo manda al confirmar", async () => {
    // El backend ya sabía hacerlo (`transfer_open_orders`) y su propio
    // mensaje de error se lo pedía al operador — pero la pantalla mandaba
    // `false` fijo y no tenía la casilla en ninguna parte.
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue({ ...NO_CAUSE_REVIEW, open_orders: 3 });
    confirmCloseMock.mockResolvedValue({ to_deposit: 0, closes_day: false });

    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} onClosed={() => {}} />, { me: { kind: "device", features: {} } });
    await user.click(await screen.findByRole("button", { name: /continuar/i }));
    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());
    await user.click(await screen.findByRole("button", { name: /continuar/i }));

    const casilla = await screen.findByRole("checkbox", { name: /trasladar al turno siguiente las 3 comandas/i });
    await user.click(casilla);
    await user.click(screen.getByRole("button", { name: /confirmar cierre/i }));

    await waitFor(() => expect(confirmCloseMock).toHaveBeenCalledTimes(1));
    expect(confirmCloseMock.mock.calls[0]![2]).toMatchObject({ transfer_open_orders: true });
  });

  it("sin comandas abiertas no ofrece el traslado", async () => {
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue({ ...NO_CAUSE_REVIEW, open_orders: 0 });

    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} onClosed={() => {}} />, { me: { kind: "device", features: {} } });
    await user.click(await screen.findByRole("button", { name: /continuar/i }));
    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());
    await user.click(await screen.findByRole("button", { name: /continuar/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /confirmar cierre/i })).toBeInTheDocument());
    expect(screen.queryByRole("checkbox", { name: /trasladar/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// «Un solo libro, dos mesas»: la diferencia con dirección y la causa a un toque
// ---------------------------------------------------------------------------

describe("CloseWizard — la diferencia se lee sin depender del color", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClosePrecheckMock.mockResolvedValue(PRECHECK_CLEAR);
    getShiftTipsMock.mockResolvedValue({ cash_out: 0 } satisfies ShiftTips);
  });

  it("un faltante se dice con flecha y palabra, y la causa se elige con un toque", async () => {
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue(FIRST_REVIEW);
    confirmCloseMock.mockResolvedValueOnce({ to_deposit: 45_000, closes_day: false });

    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} onClosed={() => {}} />, { me: { kind: "device", features: {} } });

    await user.click(await screen.findByRole("button", { name: /continuar/i }));
    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());
    // −5.000 llega del servidor: se muestra como «▼ $ 5.000 Faltan en efectivo».
    expect(screen.getByText(/faltan en efectivo/i)).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: /continuar/i }));
    const confirmar = await screen.findByRole("button", { name: /confirmar cierre/i });
    // Sin causa no se puede confirmar una diferencia que la exige.
    expect(confirmar).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: /error al dar cambio/i }));
    expect(screen.getByRole("radio", { name: /error al dar cambio/i })).toHaveAttribute("aria-checked", "true");
    await user.click(confirmar);

    await waitFor(() => expect(confirmCloseMock).toHaveBeenCalledTimes(1));
    // Viaja la diferencia CON su signo, tal como la mandó el servidor.
    expect(confirmCloseMock.mock.calls[0][2]).toMatchObject({ difference_seen: -5_000, cause: "change_error" });
  });
});

// ---------------------------------------------------------------------------
// Auditoría de tablet: paso 0, retomar el conteo sellado, volver a contar.
// ---------------------------------------------------------------------------

describe("CloseWizard — paso 0, retomar y volver a contar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClosePrecheckMock.mockResolvedValue(PRECHECK_CLEAR);
    getShiftTipsMock.mockResolvedValue({ cash_out: 0 } satisfies ShiftTips);
  });

  it("con comandas abiertas arranca en el paso 0, sin ninguna cifra, y deja pasar a contar", async () => {
    getClosePrecheckMock.mockResolvedValue({
      ...PRECHECK_CLEAR,
      open_orders: 2,
      items: [
        {
          code: "OPEN_ORDERS",
          level: "blocking",
          message: "Hay 2 comandas abiertas: cobralas o anulalas desde Mesas o Mostrador, o trasladalas al turno siguiente al confirmar el cierre",
        },
      ],
    } satisfies ClosePrecheck);
    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} onClosed={() => {}} />, {
      me: { kind: "device", features: { "pos.tables": true } },
    });

    expect(await screen.findByText("Antes de contar")).toBeInTheDocument();
    expect(screen.getByText(/Hay 2 comandas abiertas/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cobrar en Mesas" })).toHaveAttribute("href", "/pos/mesas");
    expect(document.body.textContent ?? "").not.toMatch(/\$/);

    await user.click(screen.getByRole("button", { name: "Contar el cajón" }));
    expect(await screen.findByRole("button", { name: /confirmar el conteo y continuar/i })).toBeInTheDocument();
    expect(screen.getByText(/Quedó pendiente del paso 0/)).toBeInTheDocument();
  });

  it("con un conteo ya sellado retoma en el paso 2 con lo contado del servidor, sin volver a contar", async () => {
    getClosePrecheckMock.mockResolvedValue({
      ...PRECHECK_CLEAR,
      sealed_count: { count_id: 7, counted_at: "2026-09-25T23:00:00Z", counted_by: "Ana" },
    } satisfies ClosePrecheck);
    getCloseReviewMock.mockResolvedValue({ ...FIRST_REVIEW, counted: 245_000, counted_pieces: 31 });

    renderWithProviders(<CloseWizard shiftId={1} onClosed={() => {}} />, { me: { kind: "device", features: {} } });

    await waitFor(() => expect(getCloseReviewMock).toHaveBeenCalledWith(1, 7));
    expect(await screen.findByText(/Retomaste un cierre que ya tenía el conteo sellado por Ana/)).toBeInTheDocument();
    expect(screen.getByText("31 piezas")).toBeInTheDocument();
    expect(closeCountMock).not.toHaveBeenCalled();
  });

  it("volver a contar avisa la marca para el administrador y vuelve al paso 1 con una clave nueva", async () => {
    closeCountMock.mockResolvedValue({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue(FIRST_REVIEW);
    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} onClosed={() => {}} />, { me: { kind: "device", features: {} } });

    await user.click(await screen.findByRole("button", { name: /confirmar el conteo y continuar/i }));
    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /volver a contar/i }));
    expect(screen.getByText(/recontado después de ver el esperado/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sí, volver a contar" }));

    const confirmar = await screen.findByRole("button", { name: /confirmar el conteo y continuar/i });
    await user.click(confirmar);
    await waitFor(() => expect(closeCountMock).toHaveBeenCalledTimes(2));
    expect(closeCountMock.mock.calls[0]![2]).not.toBe(closeCountMock.mock.calls[1]![2]);
  });

  it("el teclado en pantalla cuenta por denominación y avanza con «Siguiente»", async () => {
    closeCountMock.mockResolvedValue({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue(FIRST_REVIEW);
    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} onClosed={() => {}} />, { me: { kind: "device", features: {} } });

    await screen.findByRole("button", { name: /confirmar el conteo y continuar/i });
    // Arranca en $100.000: 2 billetes; «›» pasa a $50.000: 1 billete.
    await user.click(screen.getByRole("button", { name: "2" }));
    await user.click(screen.getByRole("button", { name: "Siguiente denominación" }));
    await user.click(screen.getByRole("button", { name: "1" }));
    await user.click(screen.getByRole("button", { name: "Sumar un billete de $ 20.000" }));
    await user.click(screen.getByRole("button", { name: /confirmar el conteo y continuar/i }));

    await waitFor(() => expect(closeCountMock).toHaveBeenCalledTimes(1));
    const cuerpo = closeCountMock.mock.calls[0]![1] as { counted_cash: { denominations: { value: number; count: number }[]; total: number } };
    const conPiezas = cuerpo.counted_cash.denominations.filter((d) => d.count > 0);
    expect(new Map(conPiezas.map((d) => [d.value, d.count]))).toEqual(
      new Map([
        [100_000, 2],
        [50_000, 1],
        [20_000, 1],
      ]),
    );
    expect(cuerpo.counted_cash.total).toBe(270_000);
  });
});
