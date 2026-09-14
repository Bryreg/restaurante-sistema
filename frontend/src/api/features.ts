/**
 * Admin → Funciones: catálogo de funciones habilitables, perfil de la
 * organización y su override por sede (spec § "Organizations & features").
 */
import { api } from "./client";
import type { OrganizationOut, Profile } from "./stores";

export type { OrganizationOut, Profile };

export interface Feature {
  key: string;
  description: string;
  enabled: boolean;
  source: "org" | "store_override" | "profile_default";
  requires: string[];
  available_from_phase: string;
}

export function listFeatures(storeId?: number | null): Promise<Feature[]> {
  return api<Feature[]>("/admin/features", { query: { store_id: storeId ?? undefined } });
}

export interface SetFeatureIn {
  enabled: boolean;
  store_id?: number | null;
}

export function setFeature(key: string, body: SetFeatureIn): Promise<Feature> {
  return api<Feature>(`/admin/features/${encodeURIComponent(key)}`, { method: "PUT", body });
}

/** Reinicia los flags a los defaults del perfil elegido (auditado). */
export function setProfile(profile: Profile): Promise<OrganizationOut> {
  return api<OrganizationOut>("/admin/organization/profile", { method: "POST", body: { profile } });
}
