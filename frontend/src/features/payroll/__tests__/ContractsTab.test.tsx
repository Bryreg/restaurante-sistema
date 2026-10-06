import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { AbsenceOut, ContractOut, LegalParamsOut } from "@/api/payroll"
import { renderWithProviders } from "@/test/utils"

import { ContractsTab } from "../ContractsTab"

const mocks = vi.hoisted(() => ({
  getContracts: vi.fn(),
  getAbsences: vi.fn(),
  getLegalParams: vi.fn(),
  listEmployees: vi.fn(),
}))

vi.mock("@/api/payroll", async () => {
  const actual = await vi.importActual<typeof import("@/api/payroll")>("@/api/payroll")
  return {
    ...actual,
    getContracts: mocks.getContracts,
    getAbsences: mocks.getAbsences,
    getLegalParams: mocks.getLegalParams,
  }
})
vi.mock("@/api/employees", async () => {
  const actual = await vi.importActual<typeof import("@/api/employees")>("@/api/employees")
  return { ...actual, listEmployees: mocks.listEmployees }
})

const CONTRACT: ContractOut = {
  id: 1,
  store_id: 1,
  employee_id: 7,
  employee_name: "Ana Cocina",
  kind: "indefinite",
  salary_type: "monthly",
  monthly_salary_pesos: 1_750_905,
  start_date: "2026-01-01",
  end_date: null,
  arl_risk_class: 1,
  created_by_employee_name: "Dueño",
}

const ABSENCE: AbsenceOut = {
  id: 3,
  store_id: 1,
  employee_id: 7,
  employee_name: "Ana Cocina",
  kind: "sick_leave",
  date_from: "2026-06-10",
  date_to: "2026-06-13",
  note: null,
  days: 4,
  created_by_employee_name: "Dueño",
  voided_at: null,
  voided_by_employee_name: null,
  void_reason: null,
}

const PARAMS: LegalParamsOut = {
  valid_from: "2026-01-01",
  smmlv_pesos: 1_750_905,
  transport_allowance_pesos: 249_095,
  health_employer_ppm: 85_000,
  pension_employer_ppm: 120_000,
  family_fund_ppm: 40_000,
  icbf_ppm: 30_000,
  sena_ppm: 20_000,
  severance_ppm: 83_333,
  severance_interest_ppm: 10_000,
  service_bonus_ppm: 83_333,
  vacation_ppm: 41_667,
  exonerated_114_1: true,
  source: "ley",
  confirmed_by_name: null,
}

describe("ContractsTab — contrato, novedades y parámetros legales", () => {
  it("muestra el contrato, la novedad con su botón de anular y el mínimo por confirmar", async () => {
    mocks.getContracts.mockResolvedValue([CONTRACT])
    mocks.getAbsences.mockResolvedValue([ABSENCE])
    mocks.getLegalParams.mockResolvedValue([PARAMS])
    mocks.listEmployees.mockResolvedValue([])
    renderWithProviders(<ContractsTab storeId={1} />)

    expect(await screen.findByText("Término indefinido")).toBeInTheDocument()
    expect(await screen.findByText("Incapacidad (enfermedad general)")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Anular" })).toBeInTheDocument()
    expect(await screen.findByRole("button", { name: "Confirmar" })).toBeInTheDocument()
    expect(screen.getByText(/249\.095/)).toBeInTheDocument()
  }, 20_000)
})
