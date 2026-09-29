import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import { useSession } from "@/app/session"
import { getAreaCountSettings, putAreaCountSettings } from "@/api/areaCounts"
import { getInventoryThresholds, putInventoryThresholds, type InventoryThresholds } from "@/api/inventory"
import { FormField, FormSection } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/lib/errors"

/**
 * Ajustes › Inventario y compras: los umbrales que vivían quemados en el
 * código (0035). Cada campo dice en una línea qué gobierna. Los de
 * confiabilidad de proveedores se escriben en % y viajan en puntos básicos
 * (9900 = 99 %): esa conversión es de formato de entrada, no de negocio.
 */
type Campo = {
  key: keyof InventoryThresholds
  label: string
  help: string
  bp?: boolean
  min: number
  max: number
}

const CAMPOS: readonly Campo[] = [
  {
    key: "price_jump_pct",
    label: "Salto de precio que pide confirmar (%)",
    help: "Una recepción con un precio que se aleja más que esto del promedio pide confirmación antes de entrar.",
    min: 1,
    max: 100,
  },
  {
    key: "prep_variance_alert_pct",
    label: "Rendimiento de producción que avisa (%)",
    help: "Una producción que rinde más o menos que esto contra lo teórico queda marcada con alerta.",
    min: 1,
    max: 100,
  },
  {
    key: "stale_days",
    label: "Días sin conteo completo para «no confiable»",
    help: "Pasados estos días sin un conteo completo aplicado, el food cost real se apaga y el inventario se marca no confiable.",
    min: 1,
    max: 120,
  },
  {
    key: "lot_expiring_window_days",
    label: "Días para «por vencer» en lotes",
    help: "Un lote que vence dentro de estos días sale en ámbar en Inventario › Lotes y en Hoy.",
    min: 1,
    max: 90,
  },
  {
    key: "food_cost_band_min_pct",
    label: "Food cost sano: piso (%)",
    help: "Debajo del piso la receta sale marcada «fuera de rango» en Carta › Recetas.",
    min: 1,
    max: 100,
  },
  {
    key: "food_cost_band_max_pct",
    label: "Food cost sano: techo (%)",
    help: "Encima del techo la receta sale marcada «fuera de rango» en Carta › Recetas.",
    min: 1,
    max: 100,
  },
  {
    key: "supplier_received_warning_bp",
    label: "Proveedor: recibido ÷ facturado en ámbar (%)",
    help: "Debajo de esto ya se está pagando algo que no entró.",
    bp: true,
    min: 1,
    max: 100,
  },
  {
    key: "supplier_received_critical_bp",
    label: "Proveedor: recibido ÷ facturado en rojo (%)",
    help: "Debajo de esto es faltante: el único uso del rojo.",
    bp: true,
    min: 1,
    max: 100,
  },
  {
    key: "supplier_drift_warning_bp",
    label: "Proveedor: subida de precio en ámbar (%)",
    help: "Una subida contra la compra anterior del mismo insumo desde esto pide mirar.",
    bp: true,
    min: 0.01,
    max: 100,
  },
  {
    key: "supplier_drift_critical_bp",
    label: "Proveedor: subida de precio en rojo (%)",
    help: "Desde esto, renegociar o cambiar de proveedor.",
    bp: true,
    min: 0.01,
    max: 100,
  },
  {
    key: "supplier_min_receptions",
    label: "Proveedor: recepciones mínimas",
    help: "Con menos recepciones en el rango la cifra se muestra marcada como muestra chica.",
    min: 1,
    max: 100,
  },
]

function aTexto(c: Campo, t: InventoryThresholds): string {
  const v = t[c.key]
  return c.bp ? String(v / 100) : String(v)
}

function aValor(c: Campo, texto: string): number | null {
  const n = Number(texto.trim().replace(",", "."))
  if (texto.trim() === "" || Number.isNaN(n) || n < c.min || n > c.max) return null
  return c.bp ? Math.round(n * 100) : Math.round(n)
}

export function ThresholdsSection({ storeId }: { storeId: number | null }): React.JSX.Element {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["inventory", "thresholds", storeId],
    queryFn: () => getInventoryThresholds(storeId as number),
    enabled: storeId !== null,
  })
  const [textos, setTextos] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const t = query.data
    if (t) setTextos(Object.fromEntries(CAMPOS.map((c) => [c.key, aTexto(c, t)])))
  }, [query.data])

  const mutation = useMutation({
    mutationFn: (data: Partial<InventoryThresholds>) => putInventoryThresholds(storeId as number, data),
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["inventory", "thresholds", storeId] })
    },
    onError: (err) => setError(errorMessage(err)),
  })

  if (storeId === null) {
    return <EmptyState title="Elegí una sede" description="Creá una sede en la pestaña Sedes primero." />
  }
  if (query.isLoading) return <Skeleton className="h-48 w-full" />
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        reason="error"
        title="No se pudieron cargar los umbrales"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  const valores = Object.fromEntries(CAMPOS.map((c) => [c.key, aValor(c, textos[c.key] ?? "")]))
  const invalidos = CAMPOS.filter((c) => valores[c.key] === null)

  function guardar(event: React.FormEvent): void {
    event.preventDefault()
    if (invalidos.length > 0) return
    mutation.mutate(valores as Partial<InventoryThresholds>)
  }

  return (
    <FormSection
      title="Umbrales de compras e inventario"
      governs="Desde cuándo el sistema avisa: un precio de compra raro, una producción que rinde de más o de menos, un inventario viejo, un lote por vencer, una receta cara y un proveedor que entrega de menos o sube precios."
      reading={
        <>
          Ninguno frena nada por sí solo: pintan un color o piden una confirmación. Los valores de fábrica son 15 %,
          15 %, 14 días, 7 días, 28–35 %, 99/95 %, 5/10 % y 5 recepciones.
        </>
      }
    >
      <form className="contents" onSubmit={guardar}>
        {CAMPOS.map((c) => (
          <FormField
            key={c.key}
            label={c.label}
            help={c.help}
            error={textos[c.key] !== undefined && valores[c.key] === null ? `Entre ${c.min} y ${c.max}.` : undefined}
          >
            {({ fieldId, describedBy }) => (
              <Input
                id={fieldId}
                aria-describedby={describedBy}
                inputMode="decimal"
                className="h-11"
                value={textos[c.key] ?? ""}
                onChange={(e) => setTextos((t) => ({ ...t, [c.key]: e.target.value }))}
              />
            )}
          </FormField>
        ))}
        <div className="sm:col-span-2">
          {error ? (
            <p role="alert" className="mb-2 text-sm font-medium text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={invalidos.length > 0 || mutation.isPending}>
            {mutation.isPending ? "Guardando…" : "Guardar umbrales de compras e inventario"}
          </Button>
        </div>
      </form>
    </FormSection>
  )
}

/**
 * Ajustes › Inventario › Conteo por área: los límites que antes estaban
 * quemados en el backend y repetidos en la pantalla (artículos por área, por
 * recuento, hora de sugerir «Cierre»). El umbral de aviso y el conteo
 * mensual siguen en Inventario › Conteo por área, con su enlace acá.
 */
export function AreaCountLimitsSection({ storeId }: { storeId: number | null }): React.JSX.Element | null {
  const { hasFeature } = useSession()
  const enabled = hasFeature("inventory.shift_counts") && hasFeature("inventory.perpetual")
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["area-counts", "settings", storeId],
    queryFn: () => getAreaCountSettings(storeId as number),
    enabled: storeId !== null && enabled,
  })
  const [items, setItems] = useState("")
  const [recount, setRecount] = useState("")
  const [hour, setHour] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (query.data) {
      setItems(String(query.data.max_items_per_area))
      setRecount(String(query.data.max_recount_items))
      setHour(String(query.data.suggest_closing_from_hour))
    }
  }, [query.data])

  const mutation = useMutation({
    mutationFn: () => {
      const s = query.data
      if (!s) throw new Error("Todavía no se cargó la configuración")
      return putAreaCountSettings(storeId as number, {
        threshold_pct_bp: s.threshold_pct_bp,
        threshold_amount: s.threshold_amount,
        max_items_per_area: Number(items),
        max_recount_items: Number(recount),
        suggest_closing_from_hour: Number(hour),
      })
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["area-counts", "settings", storeId] })
    },
    onError: (err) => setError(errorMessage(err)),
  })

  if (storeId === null || !enabled) return null

  const ok =
    Number.isInteger(Number(items)) && Number(items) >= 1 && Number(items) <= 100 &&
    Number.isInteger(Number(recount)) && Number(recount) >= 1 && Number(recount) <= 50 &&
    Number.isInteger(Number(hour)) && hour.trim() !== "" && Number(hour) >= 0 && Number(hour) <= 23

  return (
    <FormSection
      title="Conteo por área: límites"
      governs="Cuántos artículos cuenta cada área, cuántos entran en un recuento sorpresa y desde qué hora la tablet propone «Cierre» en vez de «Apertura»."
      reading={
        <>
          El umbral de aviso de faltantes y el conteo completo del mes se configuran en{" "}
          <Link to="/admin/inventario?tab=por-area" className="text-primary underline underline-offset-2">
            Inventario › Conteo por área
          </Link>
          .
        </>
      }
    >
      {query.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault()
            if (ok) mutation.mutate()
          }}
        >
          <FormField label="Artículos por área (máximo)" help="La lista es corta a propósito: los clave, no todo el inventario.">
            {({ fieldId, describedBy }) => (
              <Input id={fieldId} aria-describedby={describedBy} type="number" min={1} max={100} className="h-11" value={items} onChange={(e) => setItems(e.target.value)} />
            )}
          </FormField>
          <FormField label="Artículos por recuento sorpresa (máximo)" help="Un recuento es rápido: pocos artículos, contados sin ver el sistema.">
            {({ fieldId, describedBy }) => (
              <Input id={fieldId} aria-describedby={describedBy} type="number" min={1} max={50} className="h-11" value={recount} onChange={(e) => setRecount(e.target.value)} />
            )}
          </FormField>
          <FormField label="Hora desde la que se sugiere «Cierre» (0–23)" help="Sin conteo en el día, desde esta hora de Bogotá la tablet propone el conteo de cierre.">
            {({ fieldId, describedBy }) => (
              <Input id={fieldId} aria-describedby={describedBy} type="number" min={0} max={23} className="h-11" value={hour} onChange={(e) => setHour(e.target.value)} />
            )}
          </FormField>
          <div className="sm:col-span-2">
            {error ? (
              <p role="alert" className="mb-2 text-sm font-medium text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={!ok || mutation.isPending}>
              {mutation.isPending ? "Guardando…" : "Guardar límites del conteo"}
            </Button>
          </div>
        </form>
      )}
    </FormSection>
  )
}
