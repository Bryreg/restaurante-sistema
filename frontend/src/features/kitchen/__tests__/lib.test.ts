import { describe, expect, it } from "vitest"

import { channelLabel, courseLabel, elapsedFromSeconds } from "../lib"

describe("features/kitchen/lib — sólo formato, nunca plata ni recálculo", () => {
  it("channelLabel cubre el conjunto de OrderChannel y cae al texto crudo si aparece uno nuevo", () => {
    expect(channelLabel("platform")).toBe("Plataforma")
    expect(channelLabel("delivery")).toBe("Domicilio")
    expect(channelLabel(null)).toBe("—")
    expect(channelLabel("un_canal_nuevo")).toBe("un_canal_nuevo")
  })

  it("courseLabel cae al texto crudo para un curso configurado que no está en los defaults", () => {
    expect(courseLabel("main")).toBe("Fuerte")
    expect(courseLabel("brunch")).toBe("brunch")
    expect(courseLabel(undefined)).toBe("—")
  })

  it("elapsedFromSeconds no redondea a hora antes de tiempo", () => {
    expect(elapsedFromSeconds(59)).toBe("0 min")
    expect(elapsedFromSeconds(300)).toBe("5 min")
    expect(elapsedFromSeconds(3600)).toBe("1 h 0 min")
    expect(elapsedFromSeconds(3661)).toBe("1 h 1 min")
  })
})
