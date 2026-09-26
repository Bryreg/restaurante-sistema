import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildMe, renderWithProviders } from "@/test/utils";

import DocumentPage from "../DocumentPage";
import { buildDocument } from "./fixtures";

vi.mock("@/api/documents", async () => {
  const actual = await vi.importActual<typeof import("@/api/documents")>("@/api/documents");
  return { ...actual, getDocument: vi.fn(), reprintDocument: vi.fn() };
});

const { getDocument, reprintDocument } = await import("@/api/documents");

function renderDocument(features: Record<string, boolean> = {}, state?: unknown) {
  return renderWithProviders(
    <Routes>
      <Route path="/pos/documento/:documentId" element={<DocumentPage />} />
      <Route path="/pos/mesas" element={<div>Mapa de mesas</div>} />
      <Route path="/pos/comanda/nueva" element={<div>Comanda nueva</div>} />
      <Route path="/pos/cobro/:orderId" element={<div>Cobro de la mesa</div>} />
    </Routes>,
    {
      route: state === undefined ? "/pos/documento/900" : { pathname: "/pos/documento/900", state },
      me: buildMe({ kind: "device", features }),
    },
  );
}

describe("DocumentPage", () => {
  beforeEach(() => {
    vi.mocked(getDocument).mockReset();
    vi.mocked(reprintDocument).mockReset();
  });

  it("muestra la leyenda tal cual llega y la propina en una línea aparte de la venta", async () => {
    vi.mocked(getDocument).mockResolvedValue(buildDocument());

    renderDocument();

    expect(await screen.findByText("COMPROBANTE INTERNO — no es factura ni documento equivalente")).toBeInTheDocument();
    expect(screen.getByText(/propina voluntaria \(sugerida 10%\)/i)).toBeInTheDocument();
    // El total de la venta no incluye la propina.
    expect(screen.getByText("POS-000123")).toBeInTheDocument();
  });

  it("el papel habla en palabras: canal y adquirente, sin códigos internos", async () => {
    vi.mocked(getDocument).mockResolvedValue(buildDocument());
    renderDocument();

    expect(await screen.findByText("Mesa")).toBeInTheDocument();
    expect(screen.queryByText("dine_in")).not.toBeInTheDocument();
    // Consumidor final: ni el código «13» ni el número genérico de la DIAN.
    expect(screen.getAllByText("Consumidor final").length).toBeGreaterThan(0);
    expect(screen.queryByText("222222222222")).not.toBeInTheDocument();
    expect(screen.queryByText("13")).not.toBeInTheDocument();
  });

  it("un cliente identificado muestra su tipo de documento en palabras", async () => {
    vi.mocked(getDocument).mockResolvedValue(
      buildDocument({
        customer: { doc_type: "31", doc_type_label: "NIT", final_consumer: false, doc_number: "900111222", name: "Constructora SAS" },
      }),
    );
    renderDocument();

    expect(await screen.findByText("Constructora SAS")).toBeInTheDocument();
    expect(screen.getByText("NIT")).toBeInTheDocument();
    expect(screen.getByText("900111222")).toBeInTheDocument();
  });

  it("«Qué dice este papel» llega plegado y se abre al tocarlo", async () => {
    vi.mocked(getDocument).mockResolvedValue(buildDocument());
    renderDocument();

    const titulo = await screen.findByText("Qué dice este papel");
    const plegable = titulo.closest("details");
    expect(plegable).not.toBeNull();
    expect(plegable).not.toHaveAttribute("open");
    await userEvent.setup().click(titulo);
    expect(plegable).toHaveAttribute("open");
  });

  it("muestra el estado DIAN, el CUDE y el QR cuando llegan", async () => {
    vi.mocked(getDocument).mockResolvedValue(
      buildDocument({
        document_type: "pos_equivalent",
        dian_status: "validated",
        legend: "DOCUMENTO VALIDADO POR LA DIAN",
        fiscal: {
          dian_status: "validated",
          contingency: false,
          cude: "CUDE-ABC-123",
          qr_url: "https://catalogo-vpfe.dian.gov.co/document/search?cude=abc",
          range: { id: 1, prefix: "POS", from_number: 1, to_number: 1000, resolution_number: "18760", valid_until: "2027-01-01" },
        },
      }),
    );

    renderDocument();

    expect((await screen.findAllByText("Validado")).length).toBeGreaterThan(0);
    expect(screen.getByText(/cude-abc-123/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /catalogo-vpfe/i })).toHaveAttribute(
      "href",
      "https://catalogo-vpfe.dian.gov.co/document/search?cude=abc",
    );
  });

  it("un documento en contingencia muestra su leyenda de contingencia", async () => {
    vi.mocked(getDocument).mockResolvedValue(
      buildDocument({
        document_type: "pos_equivalent",
        dian_status: "contingency",
        legend: "EXPEDIDO EN CONTINGENCIA — pendiente de transmisión a la DIAN (art. 616-1 ET)",
        fiscal: { dian_status: "contingency", contingency: true, cude: null, qr_url: null, range: null },
      }),
    );

    renderDocument();

    expect(await screen.findByText(/expedido en contingencia/i)).toBeInTheDocument();
    expect(screen.getAllByText("Contingencia").length).toBeGreaterThan(0);
  });

  it("reimprimir queda contado por el servidor (reprint_count)", async () => {
    vi.mocked(getDocument).mockResolvedValue(buildDocument({ reprint_count: 0 }));
    vi.mocked(reprintDocument).mockResolvedValue(buildDocument({ reprint_count: 1 }));
    const user = userEvent.setup();

    renderDocument();

    expect(await screen.findByText(/reimpresiones: 0/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /reimprimir/i }));

    await waitFor(() => expect(reprintDocument).toHaveBeenCalledWith(900));
    expect(await screen.findByText(/reimpresiones: 1/i)).toBeInTheDocument();
  });

  it("«Volver» respeta pos.tables", async () => {
    vi.mocked(getDocument).mockResolvedValue(buildDocument());
    const user = userEvent.setup();

    renderDocument({ "pos.tables": true });

    await screen.findByText("POS-000123");
    await user.click(screen.getByRole("button", { name: "Volver" }));

    expect(await screen.findByText("Mapa de mesas")).toBeInTheDocument();
  });

  it("«Volver» sin pos.tables va a comanda nueva", async () => {
    vi.mocked(getDocument).mockResolvedValue(buildDocument());
    const user = userEvent.setup();

    renderDocument({ "pos.tables": false });

    await screen.findByText("POS-000123");
    await user.click(screen.getByRole("button", { name: "Volver" }));

    expect(await screen.findByText("Comanda nueva")).toBeInTheDocument();
  });

  it("tras cobrar una parte con partes pendientes, «Seguir cobrando la mesa» vuelve a ese cobro", async () => {
    vi.mocked(getDocument).mockResolvedValue(buildDocument());
    const user = userEvent.setup();

    renderDocument({ "pos.tables": true }, { seguirCobrando: 42 });

    await screen.findByText("POS-000123");
    expect(screen.queryByRole("button", { name: "Volver" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Seguir cobrando la mesa" }));

    expect(await screen.findByText("Cobro de la mesa")).toBeInTheDocument();
  });
});
