import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, ApiError, newIdempotencyKey } from "@/api/client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api client", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('convierte {error:{code,message}} en un ApiError con esos campos', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse(400, { error: { code: "FEATURE_DISABLED", message: "Encendé la función primero", feature: "pos.tables" } }),
    );

    await expect(api("/tables")).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      code: "FEATURE_DISABLED",
      message: "Encendé la función primero",
    });
  });

  it("un ApiError conserva los campos extra del servidor", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse(400, { error: { code: "FEATURE_DEPENDENCY", message: "necesita otra función", requires: "pos.combos" } }),
    );

    try {
      await api("/admin/features/pos.daily_menu");
      throw new Error("no debía resolver");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).extra).toMatchObject({ requires: "pos.combos" });
    }
  });

  it("manda credentials: include siempre", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await api("/auth/me");

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init).toMatchObject({ credentials: "include" });
  });

  it("manda el encabezado Idempotency-Key cuando se pide", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const key = newIdempotencyKey();
    await api("/shifts/1/cash-movements", { method: "POST", body: { amount: 1000 }, idempotencyKey: key });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(key);
  });

  it("no manda Idempotency-Key cuando no se pide", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await api("/auth/me");

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("dispara \"session:expired\" ante un 401", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse(401, { error: { code: "NOT_AUTHENTICATED", message: "Iniciá sesión" } }),
    );
    const handler = vi.fn();
    window.addEventListener("session:expired", handler);

    await expect(api("/auth/me")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);

    window.removeEventListener("session:expired", handler);
  });

  it("un 401 IDENTIFY_REQUIRED no da la sesión por vencida: sólo pide persona", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse(401, { error: { code: "IDENTIFY_REQUIRED", message: "Identificate con tu PIN" } }),
    );
    const expired = vi.fn();
    const identify = vi.fn();
    window.addEventListener("session:expired", expired);
    window.addEventListener("session:identify-required", identify);

    await expect(api("/kitchen/items/1/bump", { method: "POST" })).rejects.toMatchObject({ code: "IDENTIFY_REQUIRED" });
    expect(expired).not.toHaveBeenCalled();
    expect(identify).toHaveBeenCalledTimes(1);

    window.removeEventListener("session:expired", expired);
    window.removeEventListener("session:identify-required", identify);
  });

  it("newIdempotencyKey devuelve un UUID distinto cada vez", () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
