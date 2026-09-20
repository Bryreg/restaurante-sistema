import { useState } from "react"

import type { ProductAdminOut, ProductIn, ProductUpdateIn, TaxCode } from "@/api/catalog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DialogClose,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { formatCOP, parseCOP } from "@/lib/money"

export interface ProductFormValues {
  categoryId: number
  name: string
  description: string
  station: string
  defaultCourse: string
  dineIn: number | null
  takeout: number | null
  delivery: number | null
  platform: number | null
  taxCode: TaxCode | ""
  dailyCount: number | null
  isDeliveryFee: boolean
}

function toFormValues(product?: ProductAdminOut): ProductFormValues {
  return {
    categoryId: product?.category_id ?? 0,
    name: product?.name ?? "",
    description: product?.description ?? "",
    station: product?.station ?? "",
    defaultCourse: product?.default_course ?? "",
    dineIn: product?.prices.dine_in ?? null,
    takeout: product?.prices.takeout ?? null,
    delivery: product?.prices.delivery ?? null,
    platform: product?.prices.platform ?? null,
    taxCode: product?.tax_code ?? "",
    dailyCount: product?.daily_count ?? null,
    isDeliveryFee: product?.is_delivery_fee ?? false,
  }
}

export function formValuesToProductIn(values: ProductFormValues): ProductIn {
  return {
    category_id: values.categoryId,
    name: values.name,
    description: values.description.trim() === "" ? null : values.description,
    station: values.station.trim() === "" ? null : values.station,
    default_course: values.defaultCourse.trim() === "" ? null : values.defaultCourse,
    prices: {
      dine_in: values.dineIn ?? 0,
      takeout: values.takeout,
      delivery: values.delivery,
      platform: values.platform,
    },
    tax_code: values.taxCode === "" ? null : values.taxCode,
    daily_count: values.dailyCount,
    is_delivery_fee: values.isDeliveryFee,
  }
}

export function formValuesToProductUpdateIn(values: ProductFormValues): ProductUpdateIn {
  return {
    category_id: values.categoryId,
    name: values.name,
    description: values.description.trim() === "" ? null : values.description,
    station: values.station.trim() === "" ? null : values.station,
    default_course: values.defaultCourse.trim() === "" ? null : values.defaultCourse,
    prices: {
      dine_in: values.dineIn ?? 0,
      takeout: values.takeout,
      delivery: values.delivery,
      platform: values.platform,
    },
    tax_code: values.taxCode === "" ? null : values.taxCode,
    is_delivery_fee: values.isDeliveryFee,
  }
}

interface Category {
  id: number
  name: string
}

export function ProductForm({
  product,
  categories,
  onSubmit,
  submitting,
  submitLabel,
}: {
  product?: ProductAdminOut
  categories: Category[]
  onSubmit: (values: ProductFormValues) => void
  submitting: boolean
  submitLabel: string
}) {
  const [values, setValues] = useState<ProductFormValues>(() => toFormValues(product))

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(values)
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="product-name">Nombre</Label>
        <Input
          id="product-name"
          required
          value={values.name}
          onChange={(event) => setValues((v) => ({ ...v, name: event.target.value }))}
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="product-category">Categoría</Label>
        <Select
          value={values.categoryId ? String(values.categoryId) : undefined}
          onValueChange={(value) => setValues((v) => ({ ...v, categoryId: Number(value) }))}
        >
          <SelectTrigger id="product-category" className="w-full">
            <SelectValue placeholder="Elegí una categoría" />
          </SelectTrigger>
          <SelectContent>
            {categories.map((category) => (
              <SelectItem key={category.id} value={String(category.id)}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="product-description">Descripción</Label>
        <Textarea
          id="product-description"
          value={values.description}
          onChange={(event) => setValues((v) => ({ ...v, description: event.target.value }))}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Precio por canal</legend>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="price-dine-in">Mesa (obligatorio)</Label>
            <Input
              id="price-dine-in"
              inputMode="numeric"
              required
              value={values.dineIn === null ? "" : formatCOP(values.dineIn)}
              onChange={(event) =>
                setValues((v) => ({ ...v, dineIn: parseCOP(event.target.value) }))
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="price-takeout">Para llevar</Label>
            <Input
              id="price-takeout"
              inputMode="numeric"
              placeholder="Igual que mesa"
              value={values.takeout === null ? "" : formatCOP(values.takeout)}
              onChange={(event) =>
                setValues((v) => ({ ...v, takeout: parseCOP(event.target.value) }))
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="price-delivery">Domicilio</Label>
            <Input
              id="price-delivery"
              inputMode="numeric"
              placeholder="Igual que mesa"
              value={values.delivery === null ? "" : formatCOP(values.delivery)}
              onChange={(event) =>
                setValues((v) => ({ ...v, delivery: parseCOP(event.target.value) }))
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="price-platform">Plataforma</Label>
            <Input
              id="price-platform"
              inputMode="numeric"
              placeholder="Igual que mesa"
              value={values.platform === null ? "" : formatCOP(values.platform)}
              onChange={(event) =>
                setValues((v) => ({ ...v, platform: parseCOP(event.target.value) }))
              }
            />
          </div>
        </div>
      </fieldset>

      <label className="flex min-h-11 items-start gap-2 rounded-md border p-3 text-sm">
        <Checkbox
          checked={values.isDeliveryFee}
          onCheckedChange={(checked) => setValues((v) => ({ ...v, isDeliveryFee: checked === true }))}
        />
        <span className="space-y-0.5">
          <span className="block font-medium">Es el cargo de domicilio de esta sede</span>
          <span className="block text-muted-foreground">
            El servidor lo agrega solo, como línea, a cada comanda de domicilio (§4.3, con impuesto
            incluido); no se vende a mano desde el POS. A lo sumo un producto activo puede marcarse así por
            sede.
          </span>
        </span>
      </label>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="product-station">Estación</Label>
          <Input
            id="product-station"
            value={values.station}
            onChange={(event) => setValues((v) => ({ ...v, station: event.target.value }))}
            placeholder="Ej.: cocina caliente"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="product-course">Curso</Label>
          <Input
            id="product-course"
            value={values.defaultCourse}
            onChange={(event) => setValues((v) => ({ ...v, defaultCourse: event.target.value }))}
            placeholder="Ej.: main"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="product-tax-code">Tasa de impuesto</Label>
          <Select
            value={values.taxCode === "" ? undefined : values.taxCode}
            onValueChange={(value) => setValues((v) => ({ ...v, taxCode: value as TaxCode }))}
          >
            <SelectTrigger id="product-tax-code" className="w-full">
              <SelectValue placeholder="Por defecto de la sede" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inc_8">INC 8%</SelectItem>
              <SelectItem value="iva_19">IVA 19%</SelectItem>
              <SelectItem value="excluded">Excluido</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="product-daily-count">Contador de porciones (opcional)</Label>
          <Input
            id="product-daily-count"
            type="number"
            min={0}
            value={values.dailyCount ?? ""}
            onChange={(event) =>
              setValues((v) => ({
                ...v,
                dailyCount: event.target.value === "" ? null : Number(event.target.value),
              }))
            }
          />
        </div>
      </div>

      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancelar</DialogClose>
        <Button type="submit" disabled={submitting || values.name.trim() === "" || !values.categoryId}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}
