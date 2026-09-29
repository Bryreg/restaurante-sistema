import { useEffect, useSyncExternalStore } from "react"

import { getQuickNotes } from "@/api/stores"

import { quickNotesFor } from "./lib"

/**
 * Las notas rápidas de la sede (Ajustes › Ventas), leídas una vez por
 * tablet y refrescadas cada pocos minutos. Viven en un almacén del módulo y
 * no en React Query porque las usan piezas chicas del POS (la línea del
 * tiquete, el diálogo del ítem) que también se montan solas. Mientras no
 * llegan —o si la lectura falla— rigen las de fábrica (`quickNotesFor`).
 */
const REFRESH_MS = 5 * 60 * 1000

let notes: Record<string, string[]> | null = null
let loadedAt = 0
let loading = false
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snapshot(): Record<string, string[]> | null {
  return notes
}

function load(): void {
  if (loading || Date.now() - loadedAt < REFRESH_MS) return
  loading = true
  let pending: Promise<Record<string, string[]>>
  try {
    pending = getQuickNotes()
  } catch {
    loading = false
    return
  }
  pending
    .then((next) => {
      notes = next
      loadedAt = Date.now()
      for (const listener of listeners) listener()
    })
    .catch(() => {
      // Sin la lectura, las de fábrica: nunca un POS sin notas rápidas.
      loadedAt = Date.now()
    })
    .finally(() => {
      loading = false
    })
}

/** `(curso) => notas` con las de la sede. */
export function useQuickNotes(): (course: string | null | undefined) => readonly string[] {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    load()
  }, [])
  return (course) => quickNotesFor(course, current)
}
