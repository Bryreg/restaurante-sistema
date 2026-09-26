import { describe, expect, it } from "vitest"

import { stationLabel } from "@/lib/stations"

import {
  channelLabel,
  courseLabel,
  elapsedFromSeconds,
  hasActivePerson,
  mentionsAllergy,
  readKdsPrefs,
  worstSemaphore,
  writeKdsPrefs,
} from "../lib"

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

  it("mentionsAllergy reconoce alergias y alérgenos sin importar tildes ni mayúsculas", () => {
    for (const nota of ["ALÉRGICO al maní", "celíaco", "sin gluten por favor", "intolerante a la lactosa", "alergia a mariscos"]) {
      expect(mentionsAllergy(nota), nota).toBe(true)
    }
    for (const nota of ["sin cebolla", "término medio", "manito de cerdo", null, ""]) {
      expect(mentionsAllergy(nota), String(nota)).toBe(false)
    }
  })

  it("worstSemaphore elige el más urgente de los que mandó el servidor", () => {
    expect(worstSemaphore([])).toBe("green")
    expect(worstSemaphore(["green", undefined, "amber"])).toBe("amber")
    expect(worstSemaphore(["amber", "red", "green"])).toBe("red")
  })

  it("hasActivePerson: sin persona o vencida no hay a quién atribuir", () => {
    const now = Date.parse("2026-09-19T18:00:00Z")
    expect(hasActivePerson(null, null, now)).toBe(false)
    expect(hasActivePerson({ id: 1 }, null, now)).toBe(true)
    expect(hasActivePerson({ id: 1 }, "2026-09-19T18:01:00Z", now)).toBe(true)
    expect(hasActivePerson({ id: 1 }, "2026-09-19T17:59:00Z", now)).toBe(false)
  })

  it("las preferencias de la pantalla se mezclan, se borran con undefined y un valor roto no rompe nada", () => {
    localStorage.clear()
    writeKdsPrefs({ station: "bar", lastPerson: { id: 3, name: "Luz" } })
    writeKdsPrefs({ fullscreen: true })
    expect(readKdsPrefs()).toEqual({ station: "bar", fullscreen: true, lastPerson: { id: 3, name: "Luz" } })
    writeKdsPrefs({ station: undefined })
    expect(readKdsPrefs().station).toBeUndefined()
    localStorage.setItem("cocina-pantalla", "{no es json")
    expect(readKdsPrefs()).toEqual({})
    localStorage.clear()
  })

  it("stationLabel traduce los códigos de fábrica y deja tal cual los que creó el dueño", () => {
    expect(stationLabel("hot_kitchen")).toBe("Cocina caliente")
    expect(stationLabel("cold_kitchen")).toBe("Cocina fría")
    expect(stationLabel("bar")).toBe("Bar")
    expect(stationLabel("Parrilla")).toBe("Parrilla")
  })
})
