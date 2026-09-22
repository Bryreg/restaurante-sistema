"""Enciende TODAS las funciones del sistema en la base de demostración.

El perfil de la organización decide qué viene encendido de fábrica. El seed
deja «standard», donde **13 de las 45 funciones nacen apagadas** —domicilio,
plataformas, KDS completo, preparaciones, varianza de inventario, lotes,
banco, obligaciones, nómina, ingeniería de menú, reposición, asientos y
multi-sede—. Grabar un video mostrando pantallas de funciones apagadas es
mostrar algo que ese restaurante no tiene.

Hace dos cosas, en este orden:

1. Sube el perfil a `full`, que es el que el catálogo define con cero
   funciones apagadas por defecto.
2. Enciende explícitamente cualquiera que siga apagada por una fila propia,
   **respetando el orden de dependencias** — la misma regla que hace cumplir
   `PUT /admin/features/{key}`: no se enciende `catalog.preps` antes que
   `catalog.recipes`. Se hace en pasadas sucesivas hasta que no cambie nada,
   que es un encendido topológico sin tener que ordenar el grafo a mano.

No escribe filas salteando la validación: si una dependencia no se puede
satisfacer, la función queda apagada y se reporta.
"""
import sys

from sqlalchemy import select

from app.core import clock
from app.core.db import SessionLocal
from app.core.features import FEATURE_CATALOG, enabled_map, profile_defaults
from app.core.models_registry import import_all_models
from app.stores.models import FeatureState, Organization, Store

import_all_models()

PERFIL = "full"


def main() -> None:
    db = SessionLocal()
    org = db.execute(select(Organization).order_by(Organization.id)).scalars().first()
    store = db.execute(select(Store).order_by(Store.id)).scalars().first()
    if org is None or store is None:
        sys.exit("No hay organización o sede: corré `python -m app.seed` antes.")

    antes = enabled_map(db, org.id, store.id)
    apagadas_antes = sorted(k for k, v in antes.items() if not v)

    print(f"perfil actual: {org.profile}  ·  apagadas: {len(apagadas_antes)}")
    for k in apagadas_antes:
        print(f"  ✗ {k}")

    if org.profile != PERFIL:
        org.profile = PERFIL
        org.updated_at = clock.now_utc()
        db.commit()
        print(f"\nperfil → {PERFIL} (el catálogo lo define con cero apagadas por defecto)")

    # Pasadas sucesivas: en cada una se enciende lo que YA tiene sus
    # dependencias satisfechas. Se repite hasta que una pasada no cambia nada.
    encendidas = []
    for _ in range(len(FEATURE_CATALOG) + 1):
        flags = enabled_map(db, org.id, store.id)
        cambio = False
        for f in FEATURE_CATALOG:
            if flags.get(f.key, False):
                continue
            if any(not flags.get(dep, False) for dep in f.requires):
                continue  # todavía no: falta una dependencia
            fila = db.execute(
                select(FeatureState).where(
                    FeatureState.organization_id == org.id,
                    FeatureState.store_id.is_(None),
                    FeatureState.key == f.key,
                )
            ).scalars().first()
            if fila is None:
                fila = FeatureState(
                    organization_id=org.id, store_id=None, key=f.key, enabled=True,
                    updated_at=clock.now_utc(), updated_by="demo",
                )
                db.add(fila)
            else:
                fila.enabled = True
                fila.updated_at = clock.now_utc()
                fila.updated_by = "demo"
            db.commit()
            encendidas.append(f.key)
            cambio = True
        if not cambio:
            break

    despues = enabled_map(db, org.id, store.id)
    quedan = sorted(k for k, v in despues.items() if not v)

    print(f"\nencendidas a mano: {len(encendidas)}")
    for k in encendidas:
        print(f"  ✓ {k}")
    if quedan:
        print(f"\nSIGUEN APAGADAS ({len(quedan)}) — no se pudo satisfacer su dependencia:")
        for k in quedan:
            dep = next((f.requires for f in FEATURE_CATALOG if f.key == k), [])
            print(f"  ✗ {k}  (requiere {', '.join(dep) or '—'})")
        sys.exit(1)

    total = len(despues)
    print(f"\nlas {total} funciones del catálogo quedaron encendidas.")
    print(f"(el perfil «{PERFIL}» define {sum(profile_defaults(PERFIL).values())} de fábrica)")


if __name__ == "__main__":
    main()
