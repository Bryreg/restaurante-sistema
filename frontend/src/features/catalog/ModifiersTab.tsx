import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { useSession } from "@/app/session"
import type { ModifierGroupOut, ModifierOptionIn } from "@/api/catalog"
import {
  createModifierGroup,
  listModifierGroups,
  listProducts,
  setModifierOptionAvailability,
  updateModifierGroup,
} from "@/api/catalog"
import { Cargando } from "@/components/Cargando"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"
import { formatCOP, parseCOP } from "@/lib/money"

import { RecipeEffectDialog } from "./RecipeEffectDialog"

function GroupCard({
  group,
  productId,
  storeId,
  showRecipeEffect,
}: {
  group: ModifierGroupOut
  productId: number
  storeId: number
  showRecipeEffect: boolean
}) {
  const queryClient = useQueryClient()
  const [options, setOptions] = useState<ModifierOptionIn[]>(
    group.options.map((o) => ({ id: o.id, name: o.name, price_delta: o.price_delta }))
  )

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["catalog", "modifier-groups", productId] })

  const saveMutation = useMutation({
    mutationFn: () => updateModifierGroup(group.id, { options }),
    onSuccess: invalidate,
  })

  const availabilityMutation = useMutation({
    mutationFn: ({ optionId, available }: { optionId: number; available: boolean }) =>
      setModifierOptionAvailability(optionId, available),
    onSuccess: invalidate,
  })

  return (
    <div className="rounded-md border p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">
          {group.name}
          {group.required && <span className="ml-2 text-xs text-muted-foreground">(obligatorio)</span>}
        </h3>
        <span className="text-xs text-muted-foreground">
          Elegí entre {group.min} y {group.max}
        </span>
      </div>

      <ul className="space-y-2">
        {group.options.map((option, index) => (
          <li key={option.id} className="flex items-center gap-2">
            <Checkbox
              checked={option.available}
              onCheckedChange={(checked) =>
                availabilityMutation.mutate({ optionId: option.id, available: checked === true })
              }
              aria-label={`"${option.name}" disponible`}
            />
            <Label htmlFor={`option-name-${option.id}`} className="sr-only">
              Nombre de la opción
            </Label>
            <Input
              id={`option-name-${option.id}`}
              value={options[index]?.name ?? option.name}
              onChange={(event) =>
                setOptions((prev) =>
                  prev.map((o, i) => (i === index ? { ...o, name: event.target.value } : o))
                )
              }
              className="flex-1"
            />
            <Label htmlFor={`option-price-${option.id}`} className="sr-only">
              Ajuste de precio
            </Label>
            <Input
              id={`option-price-${option.id}`}
              className="w-32"
              value={formatCOP(options[index]?.price_delta ?? option.price_delta)}
              onChange={(event) =>
                setOptions((prev) =>
                  prev.map((o, i) =>
                    i === index ? { ...o, price_delta: parseCOP(event.target.value) ?? 0 } : o
                  )
                )
              }
            />
            {showRecipeEffect ? (
              <RecipeEffectDialog
                optionId={option.id}
                optionName={option.name}
                productId={productId}
                storeId={storeId}
              />
            ) : null}
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOptions((prev) => [...prev, { name: "", price_delta: 0 }])}
        >
          Agregar opción
        </Button>
        <Button type="button" size="sm" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
          Guardar grupo
        </Button>
      </div>
      {saveMutation.isError && <p className="text-sm text-destructive">{errorMessage(saveMutation.error)}</p>}
    </div>
  )
}

export function ModifiersTab({ storeId }: { storeId: number }) {
  const { hasFeature } = useSession()
  // `recipe_effect` sólo se ofrece con `catalog.recipes` encendida (spec
  // §4.3): sin ficha técnica en la sede, no tiene sentido editar qué le
  // suma/quita/reemplaza un modificador a un consumo que no existe.
  const showRecipeEffect = hasFeature("catalog.recipes")
  const queryClient = useQueryClient()
  const [productId, setProductId] = useState<number | null>(null)
  const [newGroupName, setNewGroupName] = useState("")

  const productsQuery = useQuery({
    queryKey: ["catalog", "products", storeId],
    queryFn: () => listProducts(storeId),
  })

  const groupsQuery = useQuery({
    queryKey: ["catalog", "modifier-groups", productId],
    queryFn: () => listModifierGroups(productId as number),
    enabled: productId !== null,
  })

  const createGroupMutation = useMutation({
    mutationFn: () => {
      if (productId === null) throw new Error("Elegí un producto primero")
      return createModifierGroup(productId, { name: newGroupName, options: [] })
    },
    onSuccess: () => {
      setNewGroupName("")
      void queryClient.invalidateQueries({ queryKey: ["catalog", "modifier-groups", productId] })
    },
  })

  if (productsQuery.isLoading) {
    return <Cargando texto="Cargando productos…" />
  }
  if (productsQuery.isError) {
    return <p className="text-sm text-destructive">{errorMessage(productsQuery.error)}</p>
  }

  const products = productsQuery.data ?? []

  return (
    <div className="space-y-4">
      <div className="max-w-sm space-y-1">
        <Label htmlFor="modifiers-product">Producto</Label>
        <Select
          value={productId === null ? undefined : String(productId)}
          onValueChange={(value) => setProductId(Number(value))}
        >
          <SelectTrigger id="modifiers-product" className="w-full">
            <SelectValue placeholder="Elegí un producto" />
          </SelectTrigger>
          <SelectContent>
            {products.map((product) => (
              <SelectItem key={product.id} value={String(product.id)}>
                {product.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {productId === null ? (
        <p className="text-sm text-muted-foreground">
          Elegí un producto para ver o crear sus grupos de modificadores.
        </p>
      ) : groupsQuery.isLoading ? (
        <Cargando texto="Cargando modificadores…" />
      ) : groupsQuery.isError ? (
        <p className="text-sm text-destructive">{errorMessage(groupsQuery.error)}</p>
      ) : (
        <div className="space-y-3">
          {(groupsQuery.data ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">Este producto todavía no tiene grupos.</p>
          )}
          {(groupsQuery.data ?? []).map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              productId={productId}
              storeId={storeId}
              showRecipeEffect={showRecipeEffect}
            />
          ))}

          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (newGroupName.trim() === "") return
              createGroupMutation.mutate()
            }}
          >
            <div className="flex-1 space-y-1">
              <Label htmlFor="new-group-name">Nuevo grupo</Label>
              <Input
                id="new-group-name"
                value={newGroupName}
                onChange={(event) => setNewGroupName(event.target.value)}
                placeholder="Ej.: Término de la carne"
              />
            </div>
            <Button type="submit" disabled={createGroupMutation.isPending || newGroupName.trim() === ""}>
              Agregar grupo
            </Button>
          </form>
        </div>
      )}
    </div>
  )
}
