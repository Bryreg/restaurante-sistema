import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildMe, renderWithProviders } from "@/test/utils";

import { PushCard } from "../PushCard";
import { urlBase64ToUint8Array } from "../pushBrowser";

const api = {
  getPushPublicKey: vi.fn(),
  listPushDevices: vi.fn(),
  subscribePush: vi.fn(),
  unsubscribePush: vi.fn(),
  sendPushTest: vi.fn(),
};

vi.mock("@/api/notifications", async () => {
  const actual = await vi.importActual<typeof import("@/api/notifications")>("@/api/notifications");
  return {
    ...actual,
    getPushPublicKey: (...a: unknown[]) => api.getPushPublicKey(...a),
    listPushDevices: (...a: unknown[]) => api.listPushDevices(...a),
    subscribePush: (...a: unknown[]) => api.subscribePush(...a),
    unsubscribePush: (...a: unknown[]) => api.unsubscribePush(...a),
    sendPushTest: (...a: unknown[]) => api.sendPushTest(...a),
  };
});

const browser = {
  pushSupport: vi.fn(),
  notificationPermission: vi.fn(),
  currentSubscription: vi.fn(),
  enablePushInThisBrowser: vi.fn(),
  disablePushInThisBrowser: vi.fn(),
};

vi.mock("../pushBrowser", async () => {
  const actual = await vi.importActual<typeof import("../pushBrowser")>("../pushBrowser");
  return {
    ...actual,
    pushSupport: () => browser.pushSupport(),
    notificationPermission: () => browser.notificationPermission(),
    currentSubscription: () => browser.currentSubscription(),
    enablePushInThisBrowser: (...a: unknown[]) => browser.enablePushInThisBrowser(...a),
    disablePushInThisBrowser: () => browser.disablePushInThisBrowser(),
  };
});

const PHONE = {
  id: 3,
  label: "iPhone",
  endpoint: "https://web.push.apple.com/abc",
  created_at: "2026-09-26T15:00:00Z",
  last_success_at: null,
  last_error: null,
};
const SUB = { endpoint: PHONE.endpoint, keys: { p256dh: "BPk", auth: "au" } };

function render() {
  return renderWithProviders(<PushCard />, { me: buildMe({ features: { "notifications.push": true } }) });
}

describe("Avisos al celular", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    Object.values(browser).forEach((f) => f.mockReset());
    browser.pushSupport.mockReturnValue("supported");
    browser.notificationPermission.mockReturnValue("default");
    browser.currentSubscription.mockResolvedValue(null);
    browser.disablePushInThisBrowser.mockResolvedValue(undefined);
    api.listPushDevices.mockResolvedValue([]);
  });

  it("activa este celular: pide la clave, se suscribe y lo lista", async () => {
    api.getPushPublicKey.mockResolvedValue({ public_key: "BKey" });
    browser.enablePushInThisBrowser.mockResolvedValue(SUB);
    api.subscribePush.mockResolvedValue(PHONE);
    render();
    expect(await screen.findByText("Ningún celular recibe avisos todavía.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar aviso de prueba" })).toBeDisabled();

    api.listPushDevices.mockResolvedValue([PHONE]);
    await userEvent.click(screen.getByRole("button", { name: "Activar en este celular" }));

    await waitFor(() => expect(api.subscribePush).toHaveBeenCalledWith(SUB));
    expect(browser.enablePushInThisBrowser).toHaveBeenCalledWith("BKey");
    expect(await screen.findByText("Este celular")).toBeInTheDocument();
    expect(screen.getByText("Este celular recibe los avisos graves.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activar en este celular" })).not.toBeInTheDocument();
  });

  it("envía el aviso de prueba y dice cuántos salieron", async () => {
    api.listPushDevices.mockResolvedValue([PHONE]);
    api.sendPushTest.mockResolvedValue({ sent: 1, failed: 0, removed: 0 });
    render();
    const boton = await screen.findByRole("button", { name: "Enviar aviso de prueba" });
    await waitFor(() => expect(boton).toBeEnabled());
    await userEvent.click(boton);
    expect(await screen.findByText("Aviso de prueba: 1 enviado.")).toBeInTheDocument();
  });

  it("«Quitar» da de baja el celular y, si es éste, también en el navegador", async () => {
    browser.currentSubscription.mockResolvedValue({ endpoint: PHONE.endpoint });
    api.listPushDevices.mockResolvedValue([PHONE]);
    api.unsubscribePush.mockResolvedValue({ removed: true });
    render();
    const quitar = await screen.findByRole("button", { name: "Quitar iPhone" });
    api.listPushDevices.mockResolvedValue([]);
    await userEvent.click(quitar);
    await waitFor(() => expect(api.unsubscribePush).toHaveBeenCalledWith({ subscription_id: 3 }));
    expect(browser.disablePushInThisBrowser).toHaveBeenCalled();
    expect(await screen.findByText("Ningún celular recibe avisos todavía.")).toBeInTheDocument();
  });

  it("un permiso negado se dice con la acción que lo arregla", async () => {
    api.getPushPublicKey.mockResolvedValue({ public_key: "BKey" });
    browser.enablePushInThisBrowser.mockRejectedValue(new Error("El navegador tiene los avisos bloqueados para este sitio."));
    render();
    await userEvent.click(await screen.findByRole("button", { name: "Activar en este celular" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("bloqueados");
    expect(api.subscribePush).not.toHaveBeenCalled();
  });

  it("en un iPhone sin agregar a inicio explica los pasos y no ofrece activar", async () => {
    browser.pushSupport.mockReturnValue("needs-install");
    render();
    expect(await screen.findByText(/se activan desde el ícono de la pantalla de inicio/)).toBeInTheDocument();
    expect(screen.getByText("Compartir → Agregar a inicio")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activar en este celular" })).not.toBeInTheDocument();
  });

  it("un navegador sin avisos lo dice sin romper", async () => {
    browser.pushSupport.mockReturnValue("unsupported");
    render();
    expect(await screen.findByText(/Este navegador no puede recibir avisos/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activar en este celular" })).not.toBeInTheDocument();
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodifica base64url sin relleno", () => {
    expect(Array.from(urlBase64ToUint8Array("AQID_-8"))).toEqual([1, 2, 3, 255, 239]);
  });
});
