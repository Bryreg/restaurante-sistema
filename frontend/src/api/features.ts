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

/** Perfil de salón (mostrador / mesa / mixto): qué `pos.*` deja cada uno. */
export type PosProfileKey = "mostrador" | "mesa" | "mixto";

export interface PosProfile {
  key: PosProfileKey;
  label: string;
  description: string;
  flags: Record<string, boolean>;
}

export interface PosProfileApplied {
  profile: PosProfileKey;
  changed: string[];
  turned_off_dependents: string[];
}

export function listPosProfiles(): Promise<PosProfile[]> {
  return api<PosProfile[]>("/admin/features/pos-profiles");
}

/** Escribe cada `pos.*` del perfil como si se moviera su interruptor (auditado). */
export function applyPosProfile(profile: PosProfileKey, storeId?: number | null): Promise<PosProfileApplied> {
  return api<PosProfileApplied>("/admin/features/pos-profile", {
    method: "POST",
    body: { profile, store_id: storeId ?? undefined },
  });
}
