import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import type { ProductAdminOut } from "@/api/catalog"
import { createProduct, listCategories, listProducts, updateProduct } from "@/api/catalog"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { formValuesToProductIn, formValuesToProductUpdateIn, ProductForm } from "./ProductForm"

/**
 * Un canal opcional en `null` no es "sin precio": cae al de mesa (§4.3). Se
 * dice así, sin ambigüedad — un "—" a secas se lee fácil como "no tiene
 * precio", que es un mensaje distinto y más grave (regalaría el producto si
 * alguien lo confundiera con `0`).
 */
function priceCell(value: number | null): string {
  return value === null ? "Igual que mesa" : formatCOP(value)
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
    return <p className="text-sm text-muted-foreground">Cargando productos…</p>
  }
  if (categoriesQuery.isError) {
    return <p className="text-sm text-destructive">{errorMessage(categoriesQuery.error)}</p>
  }
  if (productsQuery.isError) {
    return <p className="text-sm text-destructive">{errorMessage(productsQuery.error)}</p>
  }

  const categories = categoriesQuery.data ?? []
  const products = productsQuery.data ?? []

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
          Creá primero una categoría en la pestaña Categorías.
        </p>
      )}

      {products.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {search.trim() === "" ? "Todavía no hay productos." : "No hay productos que coincidan con la búsqueda."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Mesa</TableHead>
              <TableHead>Para llevar</TableHead>
              <TableHead>Domicilio</TableHead>
              <TableHead>Plataforma</TableHead>
              <TableHead>Disponible</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((product) => (
              <TableRow key={product.id}>
                <TableCell>
                  {product.name}
                  {product.is_delivery_fee ? (
                    <Badge variant="outline" className="ml-2">
                      Cargo de domicilio
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>{formatCOP(product.prices.dine_in)}</TableCell>
                <TableCell>{priceCell(product.prices.takeout)}</TableCell>
                <TableCell>{priceCell(product.prices.delivery)}</TableCell>
                <TableCell>{priceCell(product.prices.platform)}</TableCell>
                <TableCell>
                  {product.available ? (
                    <Badge variant="secondary">Disponible</Badge>
                  ) : (
                    <Badge variant="destructive">Agotado</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Dialog
                    open={editing?.id === product.id}
                    onOpenChange={(open) => setEditing(open ? product : null)}
                  >
                    <DialogTrigger render={<Button variant="outline" size="sm" />}>Editar</DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Editar {product.name}</DialogTitle>
                      </DialogHeader>
                      <ProductForm
                        product={product}
                        categories={categories}
                        submitting={updateMutation.isPending}
                        submitLabel="Guardar"
                        onSubmit={(values) => updateMutation.mutate(values)}
                      />
                      {updateMutation.isError && (
                        <p className="text-sm text-destructive">{errorMessage(updateMutation.error)}</p>
                      )}
                    </DialogContent>
                  </Dialog>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
