import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import type { CategoryOut } from "@/api/catalog"
import { createCategory, listCategories, updateCategory } from "@/api/catalog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { errorMessage } from "@/lib/errors"

export function CategoriesTab({ storeId }: { storeId: number }) {
  const queryClient = useQueryClient()
  const categoriesQuery = useQuery({
    queryKey: ["catalog", "categories", storeId],
    queryFn: () => listCategories(storeId),
  })

  const [newName, setNewName] = useState("")

  const createMutation = useMutation({
    mutationFn: () => createCategory(storeId, { name: newName }),
    onSuccess: () => {
      setNewName("")
      void queryClient.invalidateQueries({ queryKey: ["catalog", "categories", storeId] })
    },
  })

  const toggleActive = useMutation({
    mutationFn: (category: CategoryOut) => updateCategory(category.id, { active: !category.active }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["catalog", "categories", storeId] })
    },
  })

  if (categoriesQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Cargando categorías…</p>
  }
  if (categoriesQuery.isError) {
    return <p className="text-sm text-destructive">{errorMessage(categoriesQuery.error)}</p>
  }

  const categories = categoriesQuery.data ?? []

  return (
    <div className="space-y-4">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (newName.trim() === "") return
          createMutation.mutate()
        }}
      >
        <div className="flex-1 space-y-1">
          <Label htmlFor="new-category-name">Nueva categoría</Label>
          <Input
            id="new-category-name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Ej.: Entradas"
          />
        </div>
        <Button type="submit" disabled={createMutation.isPending || newName.trim() === ""}>
          Agregar
        </Button>
      </form>
      {createMutation.isError && (
        <p className="text-sm text-destructive">{errorMessage(createMutation.error)}</p>
      )}

      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Todavía no hay categorías. Agregá la primera arriba.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Orden</TableHead>
              <TableHead>Activa</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.map((category) => (
              <TableRow key={category.id}>
                <TableCell>{category.name}</TableCell>
                <TableCell>{category.sort_order}</TableCell>
                <TableCell>
                  <Switch
                    checked={category.active}
                    onCheckedChange={() => toggleActive.mutate(category)}
                    aria-label={`Categoría ${category.name} activa`}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
