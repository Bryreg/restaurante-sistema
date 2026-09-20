/**
 * Fixtures propias de `features/kitchen/**` — no se importan de
 * `features/orders/__tests__/fixtures.ts` (territorio ajeno, en
 * construcción en paralelo): mismo criterio que ya usan
 * `features/shifts/__tests__/*`, `features/inventory/__tests__/*`, etc.,
 * cada una con su propio `deviceMe`.
 */
import type { Me } from "@/api/auth"
import type { KitchenPrintJobOut, KitchenRoundOut } from "@/api/kitchen"

export function deviceMe(features: Record<string, boolean> = {}): Me {
  return {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: ["counter", "dine_in", "takeout"] },
    employee: { id: 7, name: "Ana", role: "operator", can_charge: false },
    employee_expires_at: null,
    organization: { id: 1, name: "Organización de prueba" },
    features,
  }
}

export function buildKdsRound(overrides: Partial<KitchenRoundOut> = {}): KitchenRoundOut {
  return {
    order_id: 501,
    round_no: 1,
    sent_at: "2026-09-19T18:00:00Z",
    elapsed_seconds: 300,
    channel: "dine_in",
    tables: ["5"],
    takeout_name: null,
    covers: 4,
    platform: null,
    items: [
      {
        item_id: 101,
        name: "Bandeja Paisa",
        qty: 1,
        modifiers_text: null,
        note: null,
        course: "main",
        station: "hot_kitchen",
        status: "sent",
        elapsed_seconds: 120,
        target_minutes: 18,
        semaphore: "green",
        course_fired_at: null,
        bumped_by: null,
        bumped_at: null,
      },
    ],
    ...overrides,
  }
}

export function buildPrintJob(overrides: Partial<KitchenPrintJobOut> = {}): KitchenPrintJobOut {
  return {
    order_id: 501,
    round_id: 17,
    round_no: 1,
    station: "hot_kitchen",
    channel: "dine_in",
    tables: ["5"],
    items: [{ item_id: 101, name: "Bandeja Paisa", qty: 1, modifiers_text: null, note: null }],
    item_count: 1,
    printed: false,
    printed_at: null,
    printed_by: null,
    print_count: 0,
    ...overrides,
  }
}
