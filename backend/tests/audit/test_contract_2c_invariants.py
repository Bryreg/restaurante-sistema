"""Los SIETE contratos cruzados de 2c, auditados en los DOS sentidos.

La lección de 2b, con número: los cinco hallazgos de cruce de aquella ronda
fueron, los cinco, «la mitad de ida construida sin la mitad de vuelta». El
reparto de 2c declaró siete contratos de antemano; este archivo los cobra —
que la firma publicada sea la que se llama, que el registro que un dominio
hace por otro esté hecho, y que la cadena cierre.

| | Contrato | Publica | Llama |
|---|---|---|---|
| C1 | `app/orders/hooks.py` (bump/unbump/expedite/fired_at) | `orders` | `kitchen` |
| C2 | `app/channels/hooks.py::get_platform` | `channels` | `orders` |
| C4 | `app/orders/hooks.py::mark_platform_order_cancelled` | `orders` | `channels` |
| C4-bis | `app/channels/seed.py::seed_channels` | `channels` | `app/seed.py` |
| C5 | `"channels"` **y** `"kitchen"` en `MODEL_MODULES` | `channels` (dueño único) | Alembic y `create_all` |
| C6 | cadena Alembic `0013 → 0014 → 0015` | los tres agentes | el despliegue |
| C7/C8 | `src/api/channels.ts` y `src/app/router.tsx` | frontend | ver `frontend/src/audit/` |

Más el invariante HEREDADO que 2c mueve por diseño: el poste de la cadena de
migraciones (`test_migration_invariants.py`), y la comprobación de
`Duplicate Operation ID` sobre la app REAL — la regresión que en 2b produjo
dos de los cinco rojos de la corrida final.
"""

from __future__ import annotations

import ast
import inspect
import warnings
from pathlib import Path
from typing import Any

import pytest

BACKEND = Path(__file__).resolve().parents[2]


# ===========================================================================
# C1 — lo que `kitchen` llama de `orders`
# ===========================================================================


C1_SIGNATURES = {
    "bump_item": "(db, *, item_id, store_id, actor, now)",
    "unbump_item": "(db, *, item_id, store_id, actor, now)",
    "expedite_order": "(db, *, order_id, store_id, actor, now)",
    "fired_at_by_course": "(db, *, order_id)",
}


@pytest.mark.parametrize("nombre,firma", sorted(C1_SIGNATURES.items()))
def test_contract_c1_is_published_with_the_exact_signature_kitchen_calls(nombre: str, firma: str) -> None:
    """CONTRATO C1, sentido IDA: `app/orders/hooks.py` publica las cuatro
    funciones con los nombres de parámetro exactos que `app/kitchen/service.py`
    usa por palabra clave. Un rename silencioso de `item_id` a `order_item_id`
    rompe el KDS en runtime y el typecheck no lo ve (el import es dinámico)."""
    from app.orders import hooks

    fn = getattr(hooks, nombre, None)
    assert fn is not None, f"CONTRATO C1 roto: `app.orders.hooks.{nombre}` no existe"
    params = list(inspect.signature(fn).parameters)
    esperados = [p.strip() for p in firma.strip("()").split(",") if p.strip() != "*"]
    assert params == esperados, f"`{nombre}{inspect.signature(fn)}` ya no encaja con C1 {firma}"


def test_contract_c1_is_consumed_only_through_find_spec_never_by_a_direct_import() -> None:
    """CONTRATO C1, sentido VUELTA: `app/kitchen/**` no puede importar
    `app.orders.hooks` directo. Con un import directo, un dominio que todavía
    no existe tumba el arranque de toda la API (la lección de 1b-1)."""
    hallazgos: list[str] = []
    for archivo in sorted((BACKEND / "app" / "kitchen").glob("*.py")):
        arbol = ast.parse(archivo.read_text(encoding="utf-8"), filename=str(archivo))
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.Import):
                for alias in nodo.names:
                    if alias.name.startswith("app.orders.hooks"):
                        hallazgos.append(f"app/kitchen/{archivo.name}:{nodo.lineno}")
            elif isinstance(nodo, ast.ImportFrom) and (nodo.module or "").startswith("app.orders"):
                if any(a.name == "hooks" for a in nodo.names):
                    hallazgos.append(f"app/kitchen/{archivo.name}:{nodo.lineno}")
    assert not hallazgos, "`app/kitchen/**` importa `app.orders.hooks` directo: " + str(hallazgos)


def test_the_kds_never_writes_an_order_item_status_by_hand() -> None:
    """CONTRATO C1, la regla del contrato escrita como invariante: el KDS
    **no escribe** `OrderItem.status` ni `ready_at` a mano; todas sus
    escrituras pasan por los cuatro hooks. Si lo hiciera, habría dos caminos
    hacia la misma transición y sólo uno dispararía la auditoría."""
    CAMPOS = {"status", "ready_at", "served_at", "sent_at"}
    hallazgos: list[str] = []
    for archivo in sorted((BACKEND / "app" / "kitchen").glob("*.py")):
        arbol = ast.parse(archivo.read_text(encoding="utf-8"), filename=str(archivo))
        for nodo in ast.walk(arbol):
            if not isinstance(nodo, ast.Assign):
                continue
            for objetivo in nodo.targets:
                if (
                    isinstance(objetivo, ast.Attribute)
                    and objetivo.attr in CAMPOS
                    and isinstance(objetivo.value, ast.Name)
                    and objetivo.value.id in ("item", "order_item", "order")
                ):
                    hallazgos.append(f"app/kitchen/{archivo.name}:{nodo.lineno} ({objetivo.attr})")
    assert not hallazgos, (
        "el KDS escribe un campo de `app.orders.models` a mano en vez de pasar por C1: " + str(hallazgos)
    )


# ===========================================================================
# C2 — lo que `orders` llama de `channels`
# ===========================================================================


def test_contract_c2_get_platform_is_published_with_the_signature_orders_calls() -> None:
    """CONTRATO C2, IDA: la firma publicada."""
    from app.channels import hooks

    fn = getattr(hooks, "get_platform", None)
    assert fn is not None, "CONTRATO C2 roto: `app.channels.hooks.get_platform` no existe"
    assert list(inspect.signature(fn).parameters) == ["db", "store_id", "platform_id"], (
        f"C2 cambió de firma: {inspect.signature(fn)}"
    )


def test_contract_c2_returns_none_for_the_three_cases_and_never_raises(
    db: Any, store: Any, store_b: Any
) -> None:
    """CONTRATO C2, el comportamiento que `orders` asume: `None` en los TRES
    casos (no existe, otra sede, inactiva) y **nunca** levanta. Un hook de
    lectura que decide el código HTTP de otro dominio es el cruce que 2b pagó
    cuatro veces."""
    from app.channels.hooks import get_platform
    from app.channels.models import DeliveryPlatform
    from app.core import clock as clock_module

    now = clock_module.now_utc()
    inactiva = DeliveryPlatform(
        organization_id=store.organization_id,
        store_id=store.id,
        name="Apagada",
        code="apagada",
        commission_bp=500,
        active=False,
        created_at=now,
        updated_at=now,
    )
    ajena = DeliveryPlatform(
        organization_id=store_b.organization_id,
        store_id=store_b.id,
        name="Ajena",
        code="ajena",
        commission_bp=500,
        active=True,
        created_at=now,
        updated_at=now,
    )
    db.add_all([inactiva, ajena])
    db.commit()

    assert get_platform(db, store_id=store.id, platform_id=999_999) is None, "no existe → None"
    assert get_platform(db, store_id=store.id, platform_id=ajena.id) is None, "otra sede → None"
    assert get_platform(db, store_id=store.id, platform_id=inactiva.id) is None, "inactiva → None"


def test_contract_c2_is_consumed_only_through_find_spec_from_orders() -> None:
    """CONTRATO C2, VUELTA: `app/orders/**` no importa `app.channels` directo."""
    hallazgos: list[str] = []
    for archivo in sorted((BACKEND / "app" / "orders").glob("*.py")):
        arbol = ast.parse(archivo.read_text(encoding="utf-8"), filename=str(archivo))
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.Import) and any(a.name.startswith("app.channels") for a in nodo.names):
                hallazgos.append(f"app/orders/{archivo.name}:{nodo.lineno}")
            elif isinstance(nodo, ast.ImportFrom) and (nodo.module or "").startswith("app.channels"):
                hallazgos.append(f"app/orders/{archivo.name}:{nodo.lineno}")
    assert not hallazgos, "`app/orders/**` importa `app.channels` directo: " + str(hallazgos)


# ===========================================================================
# C4 — lo que `channels` llama de `orders`
# ===========================================================================


def test_contract_c4_mark_platform_order_cancelled_is_published_and_called_by_find_spec() -> None:
    """CONTRATO C4, los dos sentidos: `orders` publica
    `mark_platform_order_cancelled` con la firma que `channels` usa, y
    `channels` la llama con `find_spec_safe`, nunca con un import directo."""
    from app.orders import hooks

    fn = getattr(hooks, "mark_platform_order_cancelled", None)
    assert fn is not None, "CONTRATO C4 roto: `mark_platform_order_cancelled` no existe"
    assert list(inspect.signature(fn).parameters) == ["db", "order", "actor", "now", "reason"], (
        f"C4 cambió de firma: {inspect.signature(fn)}"
    )

    hallazgos: list[str] = []
    for archivo in sorted((BACKEND / "app" / "channels").glob("*.py")):
        arbol = ast.parse(archivo.read_text(encoding="utf-8"), filename=str(archivo))
        for nodo in ast.walk(arbol):
            if isinstance(nodo, ast.Import) and any(a.name.startswith("app.orders.hooks") for a in nodo.names):
                hallazgos.append(f"app/channels/{archivo.name}:{nodo.lineno}")
            elif isinstance(nodo, ast.ImportFrom) and (nodo.module or "") == "app.orders":
                if any(a.name == "hooks" for a in nodo.names):
                    hallazgos.append(f"app/channels/{archivo.name}:{nodo.lineno}")
    assert not hallazgos, "`app/channels/**` importa `app.orders.hooks` directo: " + str(hallazgos)


def test_channels_never_writes_a_single_line_inside_app_orders() -> None:
    """La regla de territorio hecha invariante: `app/channels/**` no importa
    `app.orders.models` ni `app.orders.service` para ESCRIBIR. Lee el modelo
    (`Order`, `OrderChannel`) desde el router para clasificar, que es lectura;
    escribir pasa por C4."""
    from app.channels import service as channels_service

    fuente = Path(inspect.getfile(channels_service)).read_text(encoding="utf-8")
    arbol = ast.parse(fuente)
    hallazgos: list[str] = []
    for nodo in ast.walk(arbol):
        if isinstance(nodo, ast.ImportFrom) and (nodo.module or "").startswith("app.orders.service"):
            hallazgos.append(f"app/channels/service.py:{nodo.lineno}")
    assert not hallazgos, "`app/channels/service.py` importa `app.orders.service`: " + str(hallazgos)


# ===========================================================================
# C4-bis — el seed
# ===========================================================================


def test_contract_c4bis_seed_channels_is_published_and_wired_from_app_seed() -> None:
    """CONTRATO C4-bis, IDA y VUELTA: `channels` publica `seed_channels` con
    la firma que `app/seed.py` usa, y `app/seed.py` la llama de verdad. Un
    seed que no siembra la plataforma deja el camino nuevo invisible en una
    base sembrada — el huérfano que la spec nombró con dueño."""
    from app.channels import seed as channels_seed

    fn = getattr(channels_seed, "seed_channels", None)
    assert fn is not None, "CONTRATO C4-bis roto: `seed_channels` no existe"
    params = list(inspect.signature(fn).parameters)
    assert params[:3] == ["db", "organization", "store"], f"C4-bis cambió de firma: {inspect.signature(fn)}"

    fuente = (BACKEND / "app" / "seed.py").read_text(encoding="utf-8")
    assert "seed_channels" in fuente, "`app/seed.py` no llama `seed_channels`: el contrato quedó a medias"
    assert "app.channels.seed" in fuente, "`app/seed.py` no resuelve `app.channels.seed` por nombre"


def test_the_seed_actually_leaves_a_platform_and_the_two_channel_orders(db: Any) -> None:
    """CONTRATO C4-bis, verificado CORRIENDO el seed, no leyéndolo: deja una
    plataforma con comisión, una comanda de domicilio con su cargo como línea
    y una de plataforma con su `external_id`."""
    from sqlalchemy import select

    from app.channels.models import DeliveryPlatform
    from app.orders.models import Order, OrderChannel, OrderItem
    from app.seed import seed

    seed(db)
    db.commit()

    plataformas = list(db.execute(select(DeliveryPlatform)).scalars())
    assert plataformas, "el seed no dejó ninguna plataforma: el camino nuevo no se ve en una base sembrada"
    assert all(p.commission_bp > 0 for p in plataformas), (
        f"una plataforma sembrada quedó con comisión 0: {[(p.name, p.commission_bp) for p in plataformas]}"
    )

    domicilios = list(db.execute(select(Order).where(Order.channel == OrderChannel.DELIVERY)).scalars())
    assert domicilios, "el seed no dejó ninguna comanda de domicilio"
    pedido = domicilios[0]
    assert pedido.delivery_address and pedido.delivery_phone and pedido.courier_employee_id, (
        "la comanda de domicilio sembrada no tiene los tres datos del canal"
    )
    lineas = list(db.execute(select(OrderItem).where(OrderItem.order_id == pedido.id)).scalars())
    cargos = [linea for linea in lineas if linea.station is None and linea.unit_price > 0]
    assert cargos, f"la comanda de domicilio sembrada no trae el cargo como LÍNEA: {[l.name for l in lineas]}"

    plataforma_orders = list(db.execute(select(Order).where(Order.channel == OrderChannel.PLATFORM)).scalars())
    assert plataforma_orders, "el seed no dejó ninguna comanda de plataforma"
    assert plataforma_orders[0].platform_external_id, "la comanda de plataforma sembrada no tiene `external_id`"
    assert plataforma_orders[0].platform_commission_bp is not None, (
        "la comanda de plataforma sembrada no congeló el porcentaje de comisión"
    )


# ===========================================================================
# C5 — los dos dominios registrados por un solo dueño
# ===========================================================================


def test_contract_c5_both_channels_and_kitchen_are_registered_in_model_modules() -> None:
    """CONTRATO C5, y es el que decide si todo lo demás es humo.

    `"kitchen"` nunca estuvo en `MODEL_MODULES` porque hasta 2b ese dominio no
    tenía modelos. Si falta, las tablas del KDS **no entran a
    `Base.metadata`** — no existen ni para Alembic ni para `create_all` en los
    tests — y su dueño no lo puede arreglar desde su territorio. Es H-0 de 2b
    en su forma exacta.
    """
    from app.core.models_registry import MODEL_MODULES

    assert "channels" in MODEL_MODULES, "`channels` no está en MODEL_MODULES"
    assert "kitchen" in MODEL_MODULES, (
        "`kitchen` NO está en MODEL_MODULES: las tablas del KDS no existen en el esquema"
    )


def test_contract_c5_the_kitchen_tables_really_reach_base_metadata() -> None:
    """CONTRATO C5, la prueba de que el contrato cierra de los dos lados: no
    alcanza con que el registro tenga la clave — las tablas tienen que estar
    de verdad en `Base.metadata` después de `import_all_models()`."""
    from app.core.db import Base
    from app.core.models_registry import import_all_models

    import_all_models()
    tablas = set(Base.metadata.tables)
    for esperada in ("kitchen_bump_events", "kitchen_print_jobs"):
        assert esperada in tablas, f"{esperada} no llegó a Base.metadata (C5 a medias)"
    for esperada in (
        "delivery_platforms",
        "delivery_settlements",
        "platform_receivables",
        "platform_commissions",
        "order_course_fires",
    ):
        assert esperada in tablas, f"{esperada} no llegó a Base.metadata"


def test_channels_is_mounted_as_a_domain_and_kitchen_already_was() -> None:
    """CONTRATO C5, la otra lista: `DOMAINS` monta los routers."""
    from app.main import DOMAINS

    assert "channels" in DOMAINS, "`channels` no está en DOMAINS: sus 12 rutas no se montan"
    assert "kitchen" in DOMAINS, "`kitchen` salió de DOMAINS"


def test_the_new_domains_have_their_init_before_being_named_anywhere() -> None:
    """El «paso 0» que la spec exige: el `__init__.py` del dominio nuevo
    existe ANTES de que su nombre aparezca en `DOMAINS`/`MODEL_MODULES`. Sin
    la carpeta, `find_spec` importa el paquete padre y levanta
    `ModuleNotFoundError` en vez de resolver `None` — el defecto de 1b-1 que
    tumbaba el arranque de toda la API."""
    for dominio in ("channels", "kitchen"):
        assert (BACKEND / "app" / dominio / "__init__.py").exists(), (
            f"`app/{dominio}/__init__.py` no existe y el dominio ya está nombrado en las listas"
        )


# ===========================================================================
# C6 — la cadena de Alembic, y el poste heredado
# ===========================================================================


def test_the_alembic_chain_of_2c_is_linked_0013_0014_0015() -> None:
    """CONTRATO C6: los tres agentes escribieron una migración cada uno y la
    cadena tiene que cerrar en orden. Un `down_revision` mal puesto deja dos
    cabezas y `alembic upgrade head` falla en el deploy, no acá."""
    versiones = BACKEND / "alembic" / "versions"
    esperado = {"0013": "0012", "0014": "0013", "0015": "0014"}
    encontrados: dict[str, str | None] = {}
    for archivo in versiones.glob("*.py"):
        arbol = ast.parse(archivo.read_text(encoding="utf-8"), filename=str(archivo))
        revision: str | None = None
        down: str | None = None
        for nodo in arbol.body:
            if not isinstance(nodo, (ast.Assign, ast.AnnAssign)):
                continue
            objetivos = nodo.targets if isinstance(nodo, ast.Assign) else [nodo.target]
            nombre = next((t.id for t in objetivos if isinstance(t, ast.Name)), None)
            valor = nodo.value
            if nombre == "revision" and isinstance(valor, ast.Constant):
                revision = valor.value
            if nombre == "down_revision" and isinstance(valor, ast.Constant):
                down = valor.value
        if revision in esperado:
            encontrados[revision] = down
    assert set(encontrados) == set(esperado), (
        f"faltan migraciones de 2c: encontradas {sorted(encontrados)}, esperadas {sorted(esperado)}"
    )
    assert encontrados == esperado, f"la cadena de 2c no cierra: {encontrados}"


def test_the_openapi_of_the_real_app_has_no_duplicate_operation_id() -> None:
    """La regresión que en 2b produjo DOS de los cinco rojos de la corrida
    final: un conftest que monta un router ya montado por `DOMAINS`.
    Se genera el OpenAPI de la app REAL y se exige cero avisos."""
    from app.main import app

    with warnings.catch_warnings(record=True) as avisos:
        warnings.simplefilter("always")
        app.openapi()
    duplicados = [str(a.message) for a in avisos if "Duplicate Operation ID" in str(a.message)]
    assert not duplicados, "la app real publica rutas duplicadas: " + str(duplicados[:5])


def test_no_conftest_of_a_mounted_domain_mounts_its_router_again() -> None:
    """La regresión de 2b (R-1), como invariante y no como sorpresa: si un
    `tests/<dominio>/conftest.py` monta un router, tiene que llevar el guard
    de `DOMAINS` que ya usa `tests/inventory/conftest.py:23`. Vale para los
    conftests nuevos de 2c (`tests/channels/`, `tests/kitchen/`) y para los
    heredados."""
    hallazgos: list[str] = []
    for conftest in sorted((BACKEND / "tests").glob("*/conftest.py")):
        texto = conftest.read_text(encoding="utf-8")
        arbol = ast.parse(texto, filename=str(conftest))
        # LLAMADA real, no la palabra en un docstring (eso es lo que separa
        # un invariante de un grep).
        monta = any(
            isinstance(n, ast.Call)
            and isinstance(n.func, ast.Attribute)
            and n.func.attr == "include_router"
            for n in ast.walk(arbol)
        )
        if not monta:
            continue
        if "DOMAINS" not in texto:
            hallazgos.append(f"tests/{conftest.parent.name}/conftest.py monta un router sin mirar DOMAINS")
    assert not hallazgos, str(hallazgos)


# ===========================================================================
# El invariante heredado que 2c MUEVE (no afloja): el poste de la cadena
# ===========================================================================


def test_the_migration_chain_pin_was_moved_to_the_head_of_2c() -> None:
    """Invariante HEREDADO, re-apuntado por 2c y declarado en el informe.

    `test_migration_invariants.py::test_the_chain_reaches_the_three_migrations_of_cost_and_inventory`
    fijaba `head == "0012"` y 72 tablas. 2c agrega `0013`/`0014`/`0015` y
    **siete** tablas (`order_course_fires`, `delivery_platforms`,
    `delivery_settlements`, `platform_receivables`, `platform_commissions`,
    `kitchen_bump_events`, `kitchen_print_jobs`) → `head == "0015"` y 79.

    **Se MUEVE el poste, no se afloja el invariante**: sigue siendo una
    igualdad exacta, no un «que contenga al menos». Este test existe para que
    el número quede cobrado desde dos archivos distintos: si alguien "arregla"
    el heredado poniéndole un `>=`, éste sigue exigiendo el conjunto exacto.

    **Re-apuntado dos veces más, y la segunda vez porque ESTE test hizo su
    trabajo** (orquestador humano):

    - Al cerrar **H-3** moví el poste del archivo heredado a `"0016"` y
      **me olvidé de esta contraparte**. Y no lo vi en la corrida completa,
      por una razón que vale la pena dejar escrita: la suite ya había pasado
      por este archivo (corre mucho antes, alfabéticamente) cuando edité el
      otro a mitad de corrida, así que leyó la versión vieja y pasó. Un test
      que lee el CÓDIGO FUENTE de otro archivo mide el árbol en el instante en
      que corre, no el árbol final — si se toca el archivo medido durante la
      corrida, el resultado no vale.
    - En la **fase 3** la cadena llega a `"0020"` (`0017` banco, `0018`
      obligaciones, `0019` la columna `invoice_total` de D-2, `0020` nómina) y
      el conteo pasa a **93** tablas de dominio: 79 + 4 + 3 + 7. `0019` no
      suma porque agrega una columna, no una tabla, y `analytics` no suma
      porque no tiene modelos a propósito. Medido sobre Postgres 16 real.
    """
    fuente = (BACKEND / "tests" / "audit" / "test_migration_invariants.py").read_text(encoding="utf-8")
    assert 'version == "0021"' in fuente, (
        "el poste de la cadena sigue apuntando a una cabeza vieja: con A-3 cerrado la cadena llega a 0021"
    )
    assert "len(tablas) == 93" in fuente, (
        "el conteo de tablas sigue en un número viejo: la fase 3 lo deja en 93 (79 + 4 + 3 + 7)"
    )
    assert ">=" not in fuente.split("def test_the_chain_reaches_the_three_migrations_of_cost_and_inventory")[1].split("\ndef ")[0], (
        "el invariante de la cadena se aflojó a una desigualdad: un conjunto exacto se MUEVE, no se afloja"
    )
