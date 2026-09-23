import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useCocinaPantalla, useSalonTheme } from "@/app/theme";

describe("pantalla del salón por dispositivo", () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.className = "";
  });

  it("arranca clara: con luz de día la oscura refleja y se lee peor", () => {
    const { result } = renderHook(() => useSalonTheme());
    expect(result.current[0]).toBe("claro");
    expect(document.documentElement.classList.contains("salon-oscuro")).toBe(false);
  });

  it("la tablet que se pasa a oscura lo recuerda", () => {
    const { result, unmount } = renderHook(() => useSalonTheme());
    act(() => result.current[1]("oscuro"));
    expect(document.documentElement.classList.contains("salon-oscuro")).toBe(true);
    unmount();
    // Al volver a montar (otra pantalla, recarga), sigue oscura.
    const again = renderHook(() => useSalonTheme());
    expect(again.result.current[0]).toBe("oscuro");
  });

  it("la cocina pone la pizarra mientras está abierta y la quita al salir", () => {
    const { unmount } = renderHook(() => useCocinaPantalla());
    expect(document.documentElement.classList.contains("cocina")).toBe(true);
    unmount();
    expect(document.documentElement.classList.contains("cocina")).toBe(false);
  });
});
