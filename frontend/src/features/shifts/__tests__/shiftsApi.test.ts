import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeCount,
  closeSingleStep,
  createCashMovement,
  createHandover,
  createPickup,
  getShiftTips,
  openShift,
} from "@/api/shifts";

/**
 * "El cliente manda Idempotency-Key en open/close/movements/pickups/
 * handovers" (checklist del entregable). `close/count` y el cierre en un
 * solo paso también la exigen (`app/core/idempotency.py`, `run_idempotent`
 * responde `400 IDEMPOTENCY_KEY_REQUIRED` sin ella) aunque no aparezcan uno
 * por uno en la lista corta de `features/fase-1a-cimientos/spec.md`.
 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("src/api/shifts.ts — Idempotency-Key", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(200, {}));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function headerFromLastCall(): Record<string, string> {
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const [, init] = calls[calls.length - 1];
    return (init?.headers ?? {}) as Record<string, string>;
  }

  it("openShift manda Idempotency-Key", async () => {
    await openShift(
      { opening_cash: { denominations: [], total: 0 }, cash_responsible_id: 1 },
      "key-open",
    );
    expect(headerFromLastCall()["Idempotency-Key"]).toBe("key-open");
  });

  it("closeCount (paso 1 del cierre) manda Idempotency-Key", async () => {
    await closeCount(1, { counted_cash: { denominations: [], total: 0 } }, "key-close-count");
    expect(headerFromLastCall()["Idempotency-Key"]).toBe("key-close-count");
  });

  it("closeSingleStep manda Idempotency-Key", async () => {
    await closeSingleStep(1, { counted_cash: { denominations: [], total: 0 }, closes_day: false }, "key-close");
    expect(headerFromLastCall()["Idempotency-Key"]).toBe("key-close");
  });

  it("createCashMovement manda Idempotency-Key", async () => {
    await createCashMovement(1, { kind: "income", cause: "other_income", amount: 1000 }, "key-movement");
    expect(headerFromLastCall()["Idempotency-Key"]).toBe("key-movement");
  });

  it("createPickup manda Idempotency-Key", async () => {
    await createPickup(1, { amount: 1000, authorizer_pin: "9999" }, "key-pickup");
    expect(headerFromLastCall()["Idempotency-Key"]).toBe("key-pickup");
  });

  it("createHandover manda Idempotency-Key", async () => {
    await createHandover(1, { kind: "spot_check", counted_cash: { denominations: [], total: 0 } }, "key-handover");
    expect(headerFromLastCall()["Idempotency-Key"]).toBe("key-handover");
  });
});

/**
 * Iteración 3 (H-8): `getShiftTips` es un `GET` — no lleva `Idempotency-Key`
 * (no mueve plata, sólo lee lo que ya calculó el servidor).
 */
describe("src/api/shifts.ts — getShiftTips (GET /shifts/{id}/tips)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(200, { cash_out: 12_345 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("pide la ruta exacta y devuelve el cuerpo tal cual, sin transformarlo", async () => {
    const result = await getShiftTips(1);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const [url] = calls[calls.length - 1];
    expect(String(url)).toContain("/shifts/1/tips");
    expect(result).toEqual({ cash_out: 12_345 });
  });
});
