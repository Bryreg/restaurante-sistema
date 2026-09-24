import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import type { ProductAdminOut } from "@/api/catalog"
import { createProduct, listCategories, listProducts, updateProduct } from "@/api/catalog"
import { DenseTable, DenseTableBar, type DenseColumn } from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { formValuesToProductIn, formValuesToProductUpdateIn, ProductForm } from "./ProductForm"

/**
 * Un canal opcional en `null` no es "sin precio": cae al de mesa (§4.3). Se
 * dice así, sin ambigüedad — un "—" a secas se lee fácil como "no tiene
 * precio", que es un mensaje distinto y más grave (regalaría el producto si
 * alguien lo confundiera con `0`).
 */
function priceCell(value: number | null): React.ReactNode {
  // Apagado: con la mayoría de los canales cayendo al de mesa, el que tiene
  // precio propio es el que tiene que saltar a la vista.
  return value === null ? <span className="text-muted-foreground">Igual que mesa</span> : formatCOP(value)
}

export function ProductsTab({ storeId }: { storeId: number }) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState("")
  const [editing, setEditing] = useState<ProductAdminOut | null>(null)
  const [creating, setCreating] = useState(false)

  const categoriesQuery = useQuery({
    queryKey: ["catalog", "categories", storeId],
    queryFn: () => listCategories(storeId),
  })
  const productsQuery = useQuery({
    queryKey: ["catalog", "products", storeId, search],
    queryFn: () => listProducts(storeId, { search: search.trim() === "" ? undefined : search.trim() }),
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["catalog", "products", storeId] })

  const createMutation = useMutation({
    mutationFn: (values: Parameters<typeof formValuesToProductIn>[0]) =>
      createProduct(storeId, formValuesToProductIn(values)),
    onSuccess: () => {
      setCreating(false)
      invalidate()
    },
  })

  const updateMutation = useMutation({
    mutationFn: (values: Parameters<typeof formValuesToProductUpdateIn>[0]) => {
      if (!editing) throw new Error("No hay producto para editar")
      return updateProduct(editing.id, formValuesToProductUpdateIn(values))
    },
    onSuccess: () => {
      setEditing(null)
      invalidate()
    },
  })

  if (categoriesQuery.isLoading || productsQuery.isLoading) {
    return <Cargando texto="Cargando productos…" />
  }
  if (categoriesQuery.isError) {
    return <p className="text-sm text-destructive">{errorMessage(categoriesQuery.error)}</p>
  }
  if (productsQuery.isError) {
    return <p className="text-sm text-destructive">{errorMessage(productsQuery.error)}</p>
  }

  const categories = categoriesQuery.data ?? []
  const products = productsQuery.data ?? []

  /**
   * Cinco a la vista (mapa de pantallas, regla 3). De los cuatro precios
   * por canal quedan mesa, domicilio y plataforma: el restaurante vende por
   * los tres y son los que más se separan —el de plataforma suele cargar la
   * comisión—. Para llevar casi siempre es el de mesa y queda detrás de «Más
   * columnas». La única acción de la fila, «Editar», sigue como botón.
   */
  const columns: readonly DenseColumn<ProductAdminOut>[] = [
    {
      key: "name",
      header: "Nombre",
      kind: "name",
      cell: (product) => (
        <>
          {product.name}
          {product.is_delivery_fee ? (
            <Badge variant="outline" className="ml-2 font-normal">
              Cargo de domicilio
            </Badge>
          ) : null}
        </>
      ),
    },
    { key: "dine_in", header: "Mesa", kind: "number", cell: (product) => formatCOP(product.prices.dine_in) },
    {
      key: "takeout",
      header: "Para llevar",
      kind: "number",
      secondary: true,
      cell: (product) => priceCell(product.prices.takeout),
    },
    { key: "delivery", header: "Domicilio", kind: "number", cell: (product) => priceCell(product.prices.delivery) },
    { key: "platform", header: "Plataforma", kind: "number", cell: (product) => priceCell(product.prices.platform) },
    {
      key: "available",
      header: "Disponible",
      cell: (product) =>
        product.available ? (
          <Badge variant="secondary">Disponible</Badge>
        ) : (
          <Badge variant="destructive">Agotado</Badge>
        ),
    },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (product) => (
        <Button variant="ghost" size="sm" onClick={() => setEditing(product)}>
          Editar
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-2">
        <div className="max-w-sm flex-1 space-y-1">
          <Label htmlFor="product-search">Buscar</Label>
          <Input
            id="product-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Nombre del producto"
          />
        </div>
        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogTrigger render={<Button disabled={categories.length === 0} />}>
            Nuevo producto
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Nuevo producto</DialogTitle>
            </DialogHeader>
            <ProductForm
              categories={categories}
              submitting={createMutation.isPending}
              submitLabel="Crear"
              onSubmit={(values) => createMutation.mutate(values)}
            />
            {createMutation.isError && (
              <p className="text-sm text-destructive">{errorMessage(createMutation.error)}</p>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {categories.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Creá primero una categoría en la pestaña Categorías (en «Más»).
        </p>
      )}

      {products.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {search.trim() === "" ? "Todavía no hay productos." : "No hay productos que coincidan con la búsqueda."}
        </p>
      ) : (
        <DenseTable
          caption="Productos de la carta, con su precio por canal"
          columns={columns}
          rows={products}
          rowKey={(product) => String(product.id)}
          bar={<DenseTableBar shown={products.length} total={products.length} noun="productos" />}
          legend={[
            {
              term: "Igual que mesa",
              meaning: "el canal no tiene precio propio y cobra el de mesa. No es $ 0 ni «sin precio».",
            },
          ]}
        />
      )}

      {/* Un solo diálogo de edición, controlado por la fila que se eligió:
          la tabla densa no escribe celdas a mano, así que el diálogo ya no
          puede vivir adentro de la fila. */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar {editing?.name}</DialogTitle>
          </DialogHeader>
          {editing ? (
            <ProductForm
              key={editing.id}
              product={editing}
              categories={categories}
              submitting={updateMutation.isPending}
              submitLabel="Guardar"
              onSubmit={(values) => updateMutation.mutate(values)}
            />
          ) : null}
          {updateMutation.isError && (
            <p className="text-sm text-destructive">{errorMessage(updateMutation.error)}</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
