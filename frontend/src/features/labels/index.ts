/**
 * Punto de entrada de las etiquetas de cocina (`inventory.labels`): la
 * pantalla del POS `/pos/etiquetas`. La lista del administrador vive en
 * Inventario (pestaña Etiquetas).
 */
import { Tag } from "lucide-react"
import { createElement } from "react"
import type { RouteObject } from "react-router-dom"

import type { NavItem } from "@/app/nav"

import { LabelsPage } from "./LabelsPage"

const posRoutes: RouteObject[] = [{ path: "etiquetas", element: createElement(LabelsPage) }]

const posNav: NavItem[] = [
  { to: "/pos/etiquetas", label: "Etiquetas", icon: Tag, feature: "inventory.labels", posGroup: "cocina" },
]

export const labelsFeature = { posRoutes, posNav }
