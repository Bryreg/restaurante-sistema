import { describe, expect, it } from "vitest"

import { stationLabel } from "@/lib/stations"

import {
  channelLabel,
  columnasQueEntran,
  courseLabel,
  elapsedFromSeconds,
  estacionesDeLaBarra,
  hasActivePerson,
  mentionsAllergy,
  readKdsPrefs,
  repartirEnColumnas,
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

describe("features/kitchen/lib — la grilla de la pizarra", () => {
  it("repartirEnColumnas va por turno: la primera fila son los primeros (los más demorados)", () => {
    expect(repartirEnColumnas([1, 2, 3, 4, 5, 6, 7], 5)).toEqual([[1, 6], [2, 7], [3], [4], [5]])
    expect(repartirEnColumnas([1, 2], 0)).toEqual([[1, 2]])
  })

  it("columnasQueEntran: cinco en 1920, tres en 1280, una sin medir", () => {
    expect(columnasQueEntran(1880)).toBe(5)
    expect(columnasQueEntran(1240)).toBe(3)
    expect(columnasQueEntran(0)).toBe(1)
  })

  it("estacionesDeLaBarra: las configuradas en su orden, sin «none», y después las vistas y la elegida", () => {
    expect(estacionesDeLaBarra(["hot_kitchen", "cold_kitchen", "none"], ["bar", "hot_kitchen"], "Parrilla")).toEqual([
      "hot_kitchen",
      "cold_kitchen",
      "bar",
      "Parrilla",
    ])
    expect(estacionesDeLaBarra(undefined, [])).toEqual([])
  })
})
