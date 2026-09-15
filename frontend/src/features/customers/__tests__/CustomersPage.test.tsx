import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/utils";

import { CustomersPage } from "../CustomersPage";

const {
  listCustomersMock,
  patchCustomerMock,
  addCustomerConsentMock,
  listCustomerRequestsMock,
  eraseCustomerMock,
} = vi.hoisted(() => ({
  listCustomersMock: vi.fn(),
  patchCustomerMock: vi.fn(),
  addCustomerConsentMock: vi.fn(),
  listCustomerRequestsMock: vi.fn(),
  eraseCustomerMock: vi.fn(),
}));

vi.mock("@/api/customers", async () => {
  const actual = await vi.importActual<typeof import("@/api/customers")>("@/api/customers");
  return {
    ...actual,
    listCustomers: listCustomersMock,
    patchCustomer: patchCustomerMock,
    addCustomerConsent: addCustomerConsentMock,
    listCustomerRequests: listCustomerRequestsMock,
    eraseCustomer: eraseCustomerMock,
  };
});

const CUSTOMER = {
  id: 5,
  doc_type: "13",
  doc_number: "1002003000",
  dv: null,
  name: "Cliente de prueba",
  email: "cliente@example.com",
  address: null,
  municipality_dane: "05001",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  erased_at: null,
};

describe("CustomersPage", () => {
  it("lista clientes y busca por número de documento", async () => {
    listCustomersMock.mockResolvedValue([CUSTOMER]);
    const user = userEvent.setup();

    renderWithProviders(<CustomersPage />);

    await waitFor(() => expect(screen.getByText("Cliente de prueba")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Número de documento"), "1002003000");
    await user.click(screen.getByRole("button", { name: "Buscar" }));

    await waitFor(() => expect(listCustomersMock).toHaveBeenLastCalledWith({ docNumber: "1002003000" }));
  });

  it('erase dice "anonimiza el maestro y deja intacto el documento fiscal"', async () => {
    listCustomersMock.mockResolvedValue([CUSTOMER]);
    listCustomerRequestsMock.mockResolvedValue([]);
    eraseCustomerMock.mockResolvedValue({ ...CUSTOMER, erased_at: "2026-09-15T20:00:00Z" });
    const user = userEvent.setup();

    renderWithProviders(<CustomersPage />);

    await waitFor(() => expect(screen.getByText("Cliente de prueba")).toBeInTheDocument());
    await user.click(screen.getByText("Cliente de prueba"));

    await user.click(await screen.findByRole("button", { name: /anonimizar \(habeas data\)/i }));
    expect(
      screen.getByText(/anonimiza el maestro y deja intacto el documento fiscal/i),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Motivo de la solicitud"), "El titular lo pidió por correo");
    await user.click(screen.getByRole("button", { name: "Anonimizar" }));

    await waitFor(() => expect(eraseCustomerMock).toHaveBeenCalledWith(5, { reason: "El titular lo pidió por correo" }));
  });

  it("un cliente ya anonimizado no ofrece corregir datos ni agregar consentimientos", async () => {
    listCustomersMock.mockResolvedValue([{ ...CUSTOMER, erased_at: "2026-09-10T00:00:00Z" }]);
    listCustomerRequestsMock.mockResolvedValue([]);
    const user = userEvent.setup();

    renderWithProviders(<CustomersPage />);

    await waitFor(() => expect(screen.getByText("Cliente de prueba")).toBeInTheDocument());
    expect(screen.getByText("Anonimizado")).toBeInTheDocument();

    await user.click(screen.getByText("Cliente de prueba"));

    expect(await screen.findByText(/este cliente está anonimizado/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument();
    expect(screen.queryByText("Registrar consentimiento")).not.toBeInTheDocument();
  });
});
