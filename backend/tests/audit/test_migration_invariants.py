"""El DDL escrito a mano tiene que decir lo mismo que los modelos.

`docs/SPEC-NEGOCIO.md §12` y las convenciones de ingeniería de 1a: Alembic
**desde el primer commit**, y el esquema de producción se construye con
`alembic upgrade head`, no con `create_all`. El resto de la suite usa
`create_all` (CONTRATO-INTERNO §4), que crea las tablas **desde los modelos**:
por construcción nunca ve el desfase entre una columna agregada al modelo y la
migración que nadie escribió. Ese desfase es "el bug más caro del go-live" de
§12, y sólo lo caza correr la cadena de verdad y comparar.

Este archivo es el único de `tests/audit` que no habla HTTP: arma una base
SQLite **propia** bajo `TMPDIR`, corre `alembic upgrade head` contra ella y
compara tabla por tabla y columna por columna contra `Base.metadata`.

Cierra el punto "SIN VERIFICAR 2" de la ronda 1 del entregable
`outputs/auditor-control.md`.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect

from app.core.db import Base
from app.core.models_registry import import_all_models

# `Base.metadata` sólo conoce las tablas de los `models.py` importados. La suite
# lo hace en `tests/conftest.py`; repetirlo acá deja el archivo honesto si
# alguna vez se corre solo.
import_all_models()

BACKEND_DIR = Path(__file__).resolve().parents[2]

# Alembic lleva su propia tabla de control: no es del dominio y no está en los
# modelos, así que nunca entra en la comparación.
ALEMBIC_BOOKKEEPING = {"alembic_version"}


def _alembic_config(database_url: str) -> Config:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    # `script_location` es relativo al `alembic.ini`; el test puede correr desde
    # cualquier cwd, así que se resuelve a absoluto.
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


@pytest.fixture()
def migrated_url(tmp_path: Path) -> Iterator[str]:
    """Un archivo SQLite **nuevo** con la cadena `0001 → 0002 → 0003` aplicada.

    Archivo propio bajo el `tmp_path` del test (que respeta `TMPDIR`): ningún
    otro agente corriendo en paralelo lo ve, y el teardown de nadie lo borra.
    """
    db_path = tmp_path / "migration-chain.db"
    url = f"sqlite:///{db_path}"
    # `alembic/env.py` lee `DATABASE_URL` y pisa lo que diga el `.ini`.
    previo = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = url
    try:
        command.upgrade(_alembic_config(url), "head")
        yield url
    finally:
        if previo is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previo


def test_the_migration_chain_builds_exactly_the_tables_of_the_models(migrated_url: str) -> None:
    """`alembic upgrade head` sobre una base vacía tiene que dejar **el mismo
    conjunto de tablas** que `Base.metadata`.

    Una tabla en los modelos y no en el DDL revienta en el primer deploy; una
    tabla en el DDL y no en los modelos es basura que nadie mantiene y que el
    próximo `--autogenerate` propone borrar.
    """
    engine = create_engine(migrated_url)
    try:
        en_el_ddl = set(inspect(engine).get_table_names()) - ALEMBIC_BOOKKEEPING
    finally:
        engine.dispose()
    en_los_modelos = set(Base.metadata.tables)

    faltan = sorted(en_los_modelos - en_el_ddl)
    sobran = sorted(en_el_ddl - en_los_modelos)
    assert not faltan and not sobran, (
        "la cadena de Alembic y los modelos no dicen lo mismo — "
        f"tablas en los modelos sin migración: {faltan}; "
        f"tablas en el DDL sin modelo: {sobran}"
    )


def test_every_migrated_table_has_exactly_the_columns_of_its_model(migrated_url: str) -> None:
    """Y tabla por tabla, **el mismo conjunto de columnas**.

    Es el desfase caro de §12: la columna existe en el modelo, los tests pasan
    con `create_all`, y en producción la consulta se cae con "no such column".
    """
    engine = create_engine(migrated_url)
    try:
        inspector = inspect(engine)
        tablas = set(inspector.get_table_names()) - ALEMBIC_BOOKKEEPING
        columnas_ddl = {t: {c["name"] for c in inspector.get_columns(t)} for t in tablas}
    finally:
        engine.dispose()

    diferencias: list[str] = []
    for nombre, tabla in sorted(Base.metadata.tables.items()):
        if nombre not in columnas_ddl:
            continue  # lo reporta el test de tablas; acá no se duplica el ruido
        en_el_modelo = {c.name for c in tabla.columns}
        faltan = sorted(en_el_modelo - columnas_ddl[nombre])
        sobran = sorted(columnas_ddl[nombre] - en_el_modelo)
        if faltan or sobran:
            diferencias.append(f"{nombre}: faltan en el DDL {faltan}; sobran en el DDL {sobran}")

    assert not diferencias, "el DDL a mano se desfasó de los modelos:\n" + "\n".join(diferencias)


def test_downgrading_to_base_leaves_no_table_of_the_application(migrated_url: str) -> None:
    """`alembic downgrade base` tiene que dejar la base **limpia**.

    Un `downgrade` que no deshace lo que hizo el `upgrade` es un rollback que
    no existe: el día que una migración salga mal en producción, la salida es
    restaurar un backup. Además es lo único que prueba que cada `down_revision`
    de la cadena está bien encadenada de verdad.
    """
    command.downgrade(_alembic_config(migrated_url), "base")

    engine = create_engine(migrated_url)
    try:
        quedaron = set(inspect(engine).get_table_names()) - ALEMBIC_BOOKKEEPING
    finally:
        engine.dispose()

    assert not quedaron, f"el downgrade dejó tablas de la aplicación en pie: {sorted(quedaron)}"


# ---------------------------------------------------------------------------
# Pedidos 1b-1 y 1b-2: `0004` … `0007`
# ---------------------------------------------------------------------------


def test_the_chain_reaches_the_four_migrations_of_the_sale(migrated_url: str) -> None:
    """`CONTRATO-INTERNO-1b-1.md §2.6` más el pedido 1b-2: `0004_orders`
    (`0003 → 0004`), `0005_payments_fiscal` (`0004 → 0005`),
    `0006_customers_refunds_tips` (`0005 → 0006`) y
    `0007_fiscal_ranges_notes` (`0006 → 0007`).

    Los dos tests de arriba comparan modelos contra DDL, pero pasarían igual
    si `head` se hubiera quedado en `0003` y las tablas nuevas **tampoco**
    estuvieran en los modelos. Este fija que existen las tablas de la venta,
    del cobro, del cliente, de la devolución pendiente y del rango de
    numeración; el **punto de llegada** de la cadena lo fija el test de 2a
    (`test_the_chain_reaches_the_three_migrations_of_cost_and_inventory`),
    que es el que hay que mover cada vez que se agrega una migración.
    """
    engine = create_engine(migrated_url)
    try:
        tablas = set(inspect(engine).get_table_names())
    finally:
        engine.dispose()

    de_la_comanda = {
        "orders",
        "order_tables",
        "order_rounds",
        "order_items",
        "order_discounts",
        "order_sub_accounts",
        "order_sub_account_items",
        "order_events",
        "waste_stubs",
    }
    del_cobro = {"fiscal_counters", "fiscal_documents", "document_reprints", "payments", "order_tips"}
    de_1b2 = {
        "fiscal_ranges",
        "customers",
        "customer_consents",
        "customer_data_requests",
        "pending_refunds",
        "tip_payouts",
        "tip_payout_distributions",
    }
    faltan = sorted((de_la_comanda | del_cobro | de_1b2) - tablas)
    assert not faltan, f"la migración de la venta no creó: {faltan}"


def test_the_numbering_range_is_defended_by_check_constraints_in_the_database(
    migrated_url: str,
) -> None:
    """§8.3: el rango tiene «desde, hasta… vigencia» y el consecutivo se
    asigna **dentro** de él. El servicio ya lo respeta; estas restricciones
    son lo que impide que un `UPDATE` a mano, una migración futura o un bug
    dejen un rango imposible (un «hasta» menor que el «desde», un
    `next_number` fuera del rango, una vigencia invertida).

    Se inspecciona el DDL, no el modelo: la defensa que importa es la que
    corre en producción aunque la aplicación esté equivocada.
    """
    from sqlalchemy import text

    engine = create_engine(migrated_url)
    try:
        with engine.connect() as conn:
            sql = conn.execute(
                text("select sql from sqlite_master where type='table' and name='fiscal_ranges'")
            ).scalar_one()
        columnas = {c["name"] for c in inspect(engine).get_columns("fiscal_ranges")}
    finally:
        engine.dispose()

    del_contrato = {
        "store_id",
        "document_type",
        "prefix",
        "from_number",
        "to_number",
        "next_number",
        "resolution_number",
        "resolution_date",
        "valid_from",
        "valid_until",
        "technical_key",
    }
    faltan = sorted(del_contrato - columnas)
    assert not faltan, f"`fiscal_ranges` no tiene lo que pide §8.3: faltan {faltan}"

    texto = (sql or "").lower()
    for nombre in (
        "ck_fiscal_ranges_to_gte_from",
        "ck_fiscal_ranges_next_gte_from",
        "ck_fiscal_ranges_next_lte_to_plus_one",
        "ck_fiscal_ranges_valid_until_gte_from",
    ):
        assert nombre in texto, (
            f"falta el CHECK `{nombre}` en la base: un rango imposible sólo lo frena la aplicación — {sql!r}"
        )


def test_the_note_points_at_the_document_it_reverses_and_the_range_that_numbered_it(
    migrated_url: str,
) -> None:
    """§8.3: «Toda corrección va por nota, nunca editando ni borrando un
    documento expedido», y la nota lleva su propio consecutivo de su propio
    rango.

    Las dos FK reales (`reverses_document_id` → `fiscal_documents.id` y
    `fiscal_range_id` → `fiscal_ranges.id`) son lo que hace **auditable** esa
    cadena: sin ellas, "qué nota corrige qué documento" y "de qué resolución
    salió este número" quedan en una columna entera sin garantía, que es
    exactamente como estaba `fiscal_range_id` en 1b-1.
    """
    engine = create_engine(migrated_url)
    try:
        fks = {
            (tuple(fk["constrained_columns"]), fk["referred_table"])
            for fk in inspect(engine).get_foreign_keys("fiscal_documents")
        }
        columnas = {c["name"] for c in inspect(engine).get_columns("fiscal_documents")}
    finally:
        engine.dispose()

    assert (("fiscal_range_id",), "fiscal_ranges") in fks, (
        f"`fiscal_documents.fiscal_range_id` no es FK real a `fiscal_ranges`: {sorted(fks)}"
    )
    assert (("reverses_document_id",), "fiscal_documents") in fks, (
        f"`fiscal_documents.reverses_document_id` no es FK auto-referencial real: {sorted(fks)}"
    )
    for columna in ("cude", "qr_url", "xml_ref", "provider_response", "validated_at", "reason"):
        assert columna in columnas, f"falta la evidencia `{columna}` que exige §8.3"


def test_one_open_order_per_table_is_defended_by_a_partial_unique_index(migrated_url: str) -> None:
    """§3.3 y §11.9: «Una mesa tiene **a lo sumo una comanda abierta**
    (constraint)»; contrato §2.2: índice único parcial
    `uq_order_tables_one_open_per_table` sobre `(table_id) WHERE released_at
    IS NULL`.

    El chequeo previo en el servicio no alcanza: entre el `SELECT` y el
    `INSERT` de dos tablets caben las dos. La única defensa real es la base, y
    tiene que ser **parcial** — sin el `WHERE`, la segunda comanda de la
    historia en esa mesa no se podría abrir nunca.
    """
    from sqlalchemy import text

    engine = create_engine(migrated_url)
    try:
        indices = {i["name"]: i for i in inspect(engine).get_indexes("order_tables")}
        with engine.connect() as conn:
            sql = conn.execute(
                text("select sql from sqlite_master where type='index' and name=:n"),
                {"n": "uq_order_tables_one_open_per_table"},
            ).scalar_one_or_none()
    finally:
        engine.dispose()

    assert "uq_order_tables_one_open_per_table" in indices, (
        f"falta el índice único parcial de «una comanda abierta por mesa»: {sorted(indices)}"
    )
    indice = indices["uq_order_tables_one_open_per_table"]
    assert indice["unique"], "el índice existe pero no es único: no defiende nada"
    assert indice["column_names"] == ["table_id"], (
        f"el índice tiene que ser sobre `table_id`: {indice['column_names']}"
    )
    assert sql is not None and "where" in sql.lower() and "released_at" in sql.lower(), (
        "el índice no es parcial: sin `WHERE released_at IS NULL` la mesa quedaría "
        f"bloqueada para siempre después de la primera comanda — {sql!r}"
    )


def test_the_consecutive_is_defended_by_unique_constraints_in_the_database(
    migrated_url: str,
) -> None:
    """§8.3: «Consecutivo estrictamente creciente, sin huecos ni
    reutilización»; contrato §2.2: `UNIQUE(store_id, document_type, prefix)`
    en `fiscal_counters`, y en `fiscal_documents` `UNIQUE(target_key)` («un
    documento por comanda o sub-cuenta») más `UNIQUE(store_id, document_type,
    prefix, number)` («consecutivo único»).

    Se inspecciona el esquema, no el servicio: el `SELECT ... FOR UPDATE` del
    contador es la defensa de primera línea, pero SQLite lo ignora y Postgres
    no protege de un bug de aplicación. Estas tres restricciones son las que
    convierten una carrera perdida en un `IntegrityError` —que el cobro
    traduce a `409`— en vez de en dos documentos con el mismo número.
    """
    engine = create_engine(migrated_url)
    try:
        inspector = inspect(engine)

        def _uniques(table: str) -> list[list[str]]:
            constraints = [
                list(c["column_names"]) for c in inspector.get_unique_constraints(table)
            ]
            indices = [
                list(i["column_names"]) for i in inspector.get_indexes(table) if i.get("unique")
            ]
            return constraints + indices

        contadores = _uniques("fiscal_counters")
        documentos = _uniques("fiscal_documents")
    finally:
        engine.dispose()

    assert ["store_id", "document_type", "prefix"] in contadores, (
        f"`fiscal_counters` no tiene UNIQUE(store_id, document_type, prefix): {contadores}"
    )
    assert ["target_key"] in documentos, (
        f"`fiscal_documents` no tiene UNIQUE(target_key): dos documentos podrían "
        f"nacer de una misma comanda — {documentos}"
    )
    assert ["store_id", "document_type", "prefix", "number"] in documentos, (
        f"`fiscal_documents` no tiene UNIQUE(store_id, document_type, prefix, number): "
        f"el consecutivo se podría reutilizar — {documentos}"
    )


# ---------------------------------------------------------------------------
# Pedido 2a: `0008_inventory` → `0009_recipes` → `0010_consumption`
# ---------------------------------------------------------------------------


def test_the_chain_reaches_the_three_migrations_of_cost_and_inventory(migrated_url: str) -> None:
    """El punto de llegada de la cadena después de 2a **y 2b**.

    De 2a: `0008_inventory` (insumos, libro de movimientos, mermas),
    `0009_recipes` (preparaciones, lotes de producción, fichas versionadas y
    `recipe_effect`) y `0010_consumption` (`order_items.cost_source` y el
    `waste_stubs.ingredient_id` que pasa a FK real).
    De 2b: `0011_purchases` (proveedores, recepciones, líneas, cuentas por
    pagar y pagos) y `0012_counts_lots` (lotes de compra, conteos a ciegas y
    los umbrales de varianza de la sede).

    De 2c: `0013_channels_orders` (precio por canal, los doce campos de
    domicilio/plataforma/cancelación en `orders`, y `order_course_fires`),
    `0014_channels_money` (plataformas, comisiones, cuenta por cobrar y
    liquidación del efectivo de domicilios, más cuatro columnas en `payments`)
    y `0015_kitchen_kds` (`kitchen_bump_events`, `kitchen_print_jobs`).

    **Actualizado en 2b, a propósito y declarado**: este test fija `head` a un
    valor EXACTO porque eso es lo que convierte "me olvidé de encadenar la
    migración" en un rojo y no en un deploy roto — y por lo mismo hay que
    moverlo en cada pedido que agregue una. La spec de 2b dice literalmente
    «Alembic arranca en `0011`», así que el punto de llegada pasa de `0010` a
    `0012` y el conteo de tablas de 63 a 72. No es acotar un invariante: es
    moverle el poste al que está atado.

    **Re-apuntado en 2c** (`auditor-canales-2c`, mismo criterio y por escrito
    en el informe): la spec de 2c dice «Alembic arranca en `0013`», y la
    cadena llega a `0015`. El conteo pasa de **72 a 79**: `order_course_fires`
    (`0013`), `delivery_platforms`/`delivery_settlements`/
    `platform_receivables`/`platform_commissions` (`0014`) y
    `kitchen_bump_events`/`kitchen_print_jobs` (`0015`). **Medido corriendo la
    cadena completa, no estimado.** Lo que se movió es el POSTE (una igualdad
    exacta que apunta a otro número); lo que NO se tocó es la forma del
    invariante: sigue siendo `==`, nunca «que contenga al menos». Qué dejó de
    estar cubierto: **nada** — el conjunto enumerado creció con los siete
    nombres nuevos, así que una tabla de más o de menos sigue siendo roja.

    **Re-apuntado otra vez al cerrar H-3** (orquestador humano): la cadena
    llega a **`0016_active_channels_backfill`**, la migración que acompaña a la
    guarda extendida de `create_order` marcando `delivery`/`platform` como
    canales activos en toda sede que ya existía. **El conteo de tablas NO
    cambia y se queda en 79**: `0016` es un respaldo de DATOS, no de esquema —
    no crea ni borra una sola tabla. Y ese es justamente el caso que este test
    existe para cubrir: agregué la migración y me olvidé del poste, así que la
    suite se puso roja acá en vez de dejar pasar un `head` desalineado. Medido
    con la cadena completa sobre Postgres 16 (`0001 → 0016`, 80 tablas
    contando `alembic_version`, una sola cabeza, y `downgrade base` limpio).

    **Re-apuntado en la FASE 3** (orquestador humano): la cadena llega a
    **`0020_payroll`** y el conteo pasa de **79 a 93**: 4 de banco (`0017`),
    3 de obligaciones (`0018`) y 7 de nómina (`0020`). `0019_invoice_total`
    (la decisión D-2) **no mueve el conteo**: agrega `receptions.invoice_total`,
    una columna, no una tabla. Y `analytics` (T4) no aparece porque **no tiene
    modelos a propósito**: toda la analítica es derivada, que es lo que §6.1
    pide («derivar en vez de almacenar»). Medido con la cadena completa sobre
    Postgres 16 real (`0001 → 0020`, una sola cabeza, 93 tablas de dominio, y
    `downgrade base` deja el esquema vacío), no estimado sumando `create_table`.

    **Re-apuntado al cerrar A-3**: la cadena llega a
    **`0021_tip_payout_source`** y el conteo **no se mueve, sigue en 93** —
    `0021` agrega la columna `tip_payouts.paid_from`, no una tabla. Es el
    tercer respaldo de esta serie que toca datos o columnas sin tocar el
    conteo (`0016`, `0019`, `0021`), y por eso el test mide las dos cosas por
    separado: si midiera sólo el número de tablas, tres migraciones habrían
    pasado sin que nadie moviera nada.

    **Re-apuntado al sacar `tolerance_identified_cause`**: la cadena llega a
    **`0022_drop_tolerance_identified_cause`** y el conteo **sigue en 93**.
    `0022` es la primera de la serie que **quita** esquema en vez de agregarlo
    —borra `store_cash_settings.tolerance_identified_cause`, el umbral que el
    dueño podía editar y que ninguna lógica de negocio leía (§3.2 define tres
    bandas con DOS fronteras, y el cierre siempre usó esas dos)—, pero borra
    una COLUMNA, no una tabla: por eso el poste de la cabeza se mueve y el del
    conteo no. Lo que este test fija es la cabeza de la cadena, no la
    dirección en que creció el esquema, así que una migración que resta se
    declara acá igual que una que suma.

    **Re-apuntado al mudar las fotos a su tabla**: la cadena llega a
    **`0023_photos`** y el conteo pasa a **94**. Las pantallas mandaban la foto
    como *data URL* y cada dominio la guardaba en una columna `String(500)`:
    en Postgres el `INSERT` fallaba por largo, y SQLite —que no hace cumplir
    el largo— lo escondía. `photos` guarda los bytes; las columnas de siempre
    guardan la dirección `/api/v1/photos/<id>`.

    **Re-apuntado al dejar la plata de días anteriores en el cajón**: la
    cadena llega a **`0024_cash_carry_and_pos_deposits`** y el conteo a
    **95** (`shift_carry_ins`). El dueño decidió que la venta sin consignar se
    queda en el cajón y que quien tiene la caja consigna desde el POS con
    confirmación del administrador; `bank_deposits` suma columnas, no tabla.

    **Re-apuntado con la rutina del turno en el POS**: la cadena llega a
    **`0025_pos_routine`** y el conteo a **100**: `reception_drafts` y
    `reception_draft_lines` (recibir sin precios), `staff_requests` y
    `staff_request_lines` (pedidos de insumos y de sencilla) y `novelties`.
    `wastes` suma columnas (consumo interno y traslado), no tabla.

    **Re-apuntado con el conteo corto por área**: la cadena llega a
    **`0026_area_counts`** y el conteo a **107**. El dueño decidió que cada
    área cuente lo suyo al abrir y al cerrar, como en los restaurantes
    grandes, y eso son siete tablas nuevas, todas de `app/inventory`:
    `count_areas`, `count_area_members` y `count_area_items` (la
    configuración: qué áreas hay, quién es de cuál y qué artículos cuenta
    cada una), `area_counts` y `area_count_lines` (los conteos, append-only),
    `area_recount_requests` (el recuento sorpresa) y `area_count_settings`
    (el umbral por sede). Ninguna tabla existente gana columnas. El poste se
    mueve; la forma del invariante —igualdad exacta sobre un conjunto
    enumerado— queda igual, y los siete nombres entran enumerados abajo.

    **Re-apuntado con el inicio por rol**: la cadena llega a
    **`0027_employee_puesto`** y el conteo **sigue en 107**. `0027` agrega la
    columna `employees.puesto` (caja, salón, cocina, bar; vacía = ve todo),
    que decide a qué pantalla llega cada persona al identificarse y qué
    destinos ve en la barra del POS, y `device_sessions.last_employee_id` (la
    última persona que usó la tablet, para ofrecerla primero). Son COLUMNAS,
    no tablas: se mueve el poste de la cabeza y el del conteo no, igual que
    `0019`, `0021` y `0022`.

    **Re-apuntado con la asistencia separada del turno de caja**: la cadena
    llega a **`0028_attendance`** y el conteo a **108**. Motivo declarado: el
    cocinero que llega a las 7 a. m., antes de que alguien abra la caja, no
    tenía hora de entrada, porque la jornada sólo existía como roster del
    turno de caja. `attendance_entries` es la jornada por sede, día operativo
    y persona; el roster queda como su proyección sobre la ventana del turno.
    Una tabla nueva, ninguna columna en tablas existentes. El poste se mueve;
    la forma del invariante —igualdad exacta sobre un conjunto enumerado—
    queda igual, y el nombre nuevo entra enumerado abajo.
    **Re-apuntado con el conteo artículo por artículo**: la cadena llega a
    **`0030_area_count_per_item`** y el conteo **sigue en 107**. El dueño
    decidió que la apertura de cada área es obligatoria, que cada artículo se
    guarda al contarlo con quién y cuándo (recontar agrega otra entrada, nada
    se pisa) y que una vez al mes se cuenta todo lo del área por categoría.
    Son COLUMNAS en `area_count_lines`, `area_counts`, `count_areas` y
    `area_count_settings`, más un índice único (`session_key`); ninguna
    tabla. Se llama `0030` y cuelga de `0027` porque en paralelo nacen
    `0028`/`0029` sobre `0027` y la cadena se re-encadena al integrar: si al
    integrar la cabeza es otra, el poste se mueve de nuevo, con su motivo.

    **Re-apuntado al integrar la apertura por sobres y la base de respaldo**
    (decisión del dueño, 2026-09-26): la cadena queda `0027 → 0028_attendance
    → 0029_envelope_opening_and_backup_base → 0030_area_count_per_item`, la
    cabeza sigue en **`0030`** y el conteo pasa de 108 a **111**. `0029` suma
    tres tablas: el conteo de apertura por sobres sellado a ciegas
    (`shift_opening_counts`) y el libro y las verificaciones de la base de
    respaldo, la plata aparte del cajón (`cash_reserve_movements`,
    `cash_reserve_checks`); `shifts` y `store_cash_settings` suman columnas.
    Se mueve el poste; las dos igualdades siguen exactas y los tres nombres
    entran enumerados abajo.
    """
    from sqlalchemy import text

    engine = create_engine(migrated_url)
    try:
        with engine.connect() as conn:
            version = conn.execute(text("select version_num from alembic_version")).scalar_one()
        tablas = set(inspect(engine).get_table_names()) - ALEMBIC_BOOKKEEPING
    finally:
        engine.dispose()

    assert version == "0030", (
        f"la cadena quedó en {version!r}; el punto de llegada es 0030: 0027 → 0028 (asistencia separada del turno de caja) "
        "→ 0029 (apertura por sobres y base de respaldo) → 0030 (conteo artículo por artículo). "
        "Si agregaste una migración, movele el poste acá y decí por qué, como hicieron "
        "2b, 2c, H-3, la fase 3, A-3, 0022, 0023, 0024, 0025, 0026, 0027, 0028, 0029 y 0030"
    )

    del_inventario = {"ingredients", "stock_movements", "wastes"}
    de_las_recetas = {
        "preparations",
        "preparation_lines",
        "prep_batches",
        "recipes",
        "recipe_versions",
        "recipe_lines",
        "modifier_option_recipe_effects",
        "modifier_option_recipe_effect_lines",
    }
    de_las_compras = {"suppliers", "receptions", "reception_lines", "payables", "purchase_payments"}
    de_los_conteos = {"stock_batches", "stock_counts", "stock_count_lines", "store_inventory_settings"}
    # Pedido 2c: los siete nombres nuevos, enumerados igual que los de 2a/2b.
    de_los_canales = {
        "order_course_fires",
        "delivery_platforms",
        "delivery_settlements",
        "platform_receivables",
        "platform_commissions",
    }
    del_kds = {"kitchen_bump_events", "kitchen_print_jobs"}
    # Fase 3: los catorce nombres nuevos, enumerados igual que los anteriores.
    # `0019_invoice_total` (D-2) no aparece acá porque no crea tabla: agrega
    # `receptions.invoice_total`, y eso lo cubre el test de paridad DDL/modelos.
    del_banco = {
        "bank_deposits",
        "bank_deposit_allocations",
        "card_settlements",
        "platform_settlements",
    }
    de_las_obligaciones = {"expenses", "obligations", "store_expenses_settings"}
    de_las_fotos = {"photos"}
    del_cajon = {"shift_carry_ins"}
    de_la_rutina = {
        "reception_drafts",
        "reception_draft_lines",
        "staff_requests",
        "staff_request_lines",
        "novelties",
    }
    del_conteo_por_area = {
        "count_areas",
        "count_area_members",
        "count_area_items",
        "area_counts",
        "area_count_lines",
        "area_recount_requests",
        "area_count_settings",
    }
    de_la_asistencia = {"attendance_entries"}
    # 2026-09-26: el conteo de apertura por sobres y la base de respaldo.
    de_la_base_de_respaldo = {"shift_opening_counts", "cash_reserve_movements", "cash_reserve_checks"}
    de_la_nomina = {
        "payroll_surcharge_tables",
        "payroll_holidays",
        "payroll_wage_rates",
        "payroll_area_assignments",
        "payroll_tip_distribution_settings",
        "payroll_runs",
        "payroll_run_lines",
    }
    faltan = sorted(
        (
            del_inventario
            | de_las_recetas
            | de_las_compras
            | de_los_conteos
            | de_los_canales
            | del_kds
            | del_banco
            | de_las_obligaciones
            | de_la_nomina
            | de_las_fotos
            | del_cajon
            | de_la_rutina
            | del_conteo_por_area
            | de_la_asistencia
            | de_la_base_de_respaldo
        )
        - tablas
    )
    assert not faltan, f"las migraciones de 2a/2b/2c/fase 3 no crearon: {faltan}"

    # El conteo total, para que agregar una tabla sin querer también se vea.
    # **Sin `alembic_version`** (no es del dominio): 52 de 1a/1b + 3 de
    # inventario + 8 de recetas = 63 al cerrar 2a; + 5 de compras
    # (`0011_purchases`) + 4 de conteos y lotes (`0012_counts_lots`) = 72 al
    # cerrar 2b; + 1 de «marchar» (`0013`) + 4 de plataformas y liquidación
    # (`0014`) + 2 del KDS (`0015`) = **79** al cerrar 2c. `0016` (el respaldo
    # de «canales activos» del cierre de H-3) NO mueve este número: toca datos,
    # no esquema. Fase 3: + 4 de banco (`0017`) + 3 de obligaciones (`0018`)
    # + 7 de nómina (`0020`) = **93**. `0019_invoice_total` tampoco lo mueve
    # (agrega una columna, no una tabla), y `analytics` (T4) no tiene modelos
    # a propósito: es todo derivado. Ojo al comparar con `docs/ESTADO.md`, que
    # para 1b anotó "53 tablas" contando la de control de Alembic: es el mismo
    # esquema contado de dos maneras. `0023_photos` suma una (94) y `0024`
    # otra (`shift_carry_ins`): 95; `0025` cinco de la rutina del turno: 100;
    # `0026` siete del conteo corto por área: **107**. `0027` (el puesto de
    # cada persona y la última que usó la tablet) agrega columnas, no tablas:
    # sigue 107. `0028` suma la asistencia del día (`attendance_entries`),
    # separada del turno de caja: 108. `0029` (apertura por sobres y base de
    # respaldo) suma tres: **111**. `0030` agrega columnas, no tablas.
    assert len(tablas) == 111, (
        f"el esquema quedó con {len(tablas)} tablas de dominio; `0029` lo deja en 111 "
        f"(79 al cerrar 2c + 4 de banco + 3 de obligaciones + 7 de nómina + 1 de fotos + 1 del cajón "
        f"+ 5 de la rutina del turno + 7 del conteo por área + 1 de asistencia "
        f"+ 3 de la apertura por sobres y la base de respaldo). "
        f"Actualizá este número junto con la migración que lo cambie: {sorted(tablas)}"
    )


def test_the_waste_stub_points_at_a_real_ingredient_with_a_foreign_key(migrated_url: str) -> None:
    """El gancho que 1b dejó abierto: `waste_stubs.ingredient_id` entró como
    `Integer` pelado porque `app.inventory` no existía. 2a lo resuelve contra
    la ficha, y la columna tiene que pasar a **FK real** — el mismo caso que
    `fiscal_range_id` en 1b-2.

    Sin la FK, una merma puede quedar apuntando a un insumo que ya no existe y
    el reporte de mermas por insumo pierde filas en silencio. La defensa que
    importa es la de la base, no la del servicio.
    """
    engine = create_engine(migrated_url)
    try:
        inspector = inspect(engine)
        fks = inspector.get_foreign_keys("waste_stubs")
        columnas_items = {c["name"] for c in inspector.get_columns("order_items")}
    finally:
        engine.dispose()

    hacia_insumos = [
        fk for fk in fks if fk.get("referred_table") == "ingredients" and "ingredient_id" in fk.get("constrained_columns", [])
    ]
    assert hacia_insumos, (
        f"`waste_stubs.ingredient_id` sigue siendo un entero pelado: {fks}"
    )

    # Y el snapshot del costo viaja completo en el ítem: cantidad, costo y
    # ORIGEN del costo (nunca un costo sin origen, §4.1).
    assert {"unit_cost", "recipe_version", "cost_source"} <= columnas_items, (
        f"al ítem le falta parte del snapshot de costo: {sorted(columnas_items)}"
    )


def test_the_ledger_is_defended_by_check_constraints_in_the_database(migrated_url: str) -> None:
    """§5.1: un movimiento es de **un** insumo o de **una** preparación, nunca
    de los dos ni de ninguno, y nunca de cantidad cero.

    El servicio ya lo valida; estas restricciones son lo que impide que un
    `UPDATE` a mano, una migración futura o un bug dejen el libro con filas que
    no suman a nada. Se inspecciona el DDL, no el modelo: la defensa que
    importa es la que corre en producción aunque la aplicación esté
    equivocada.
    """
    from sqlalchemy import text

    engine = create_engine(migrated_url)
    try:
        with engine.connect() as conn:
            ddl = conn.execute(
                text("select sql from sqlite_master where type='table' and name='stock_movements'")
            ).scalar_one()
            ddl_ingredients = conn.execute(
                text("select sql from sqlite_master where type='table' and name='ingredients'")
            ).scalar_one()
    finally:
        engine.dispose()

    normalizado = " ".join(ddl.split()).lower()
    assert "check" in normalizado, "`stock_movements` no tiene ninguna restricción CHECK"
    assert "qty_base" in normalizado and "<> 0" in normalizado.replace("!= 0", "<> 0"), (
        f"nada impide un movimiento de cantidad cero en la base: {normalizado}"
    )
    assert "ingredient_id" in normalizado and "preparation_id" in normalizado, (
        "no hay CHECK de insumo XOR preparación en `stock_movements`"
    )

    # §4.1/§11.7: el umbral mínimo nunca en cero, defendido también en la base.
    normalizado_ingredientes = " ".join(ddl_ingredients.split()).lower()
    assert "min_stock" in normalizado_ingredientes and "check" in normalizado_ingredientes, (
        f"`ingredients.min_stock` no tiene defensa en la base: {normalizado_ingredientes}"
    )


def test_the_development_seed_runs_twice_without_duplicating_and_can_exercise_2a(
    migrated_url: str,
) -> None:
    """`docs/ESTADO.md`: «el seed corre dos veces sin duplicar nada» — y la
    lección cara de 1b-2: un seed que no cargaba los rangos de numeración
    dejaba una base recién sembrada **incapaz de vender**, y nadie lo vio
    hasta el recorrido en navegador.

    La versión 2a de esa lección: si el seed no carga insumos, preparaciones y
    fichas, una base recién sembrada no puede ejercitar **ningún** camino nuevo
    de esta fase (ni costo al enviar, ni producción rápida, ni merma), y el
    recorrido en navegador va a encontrarse pantallas vacías que parecen rotas.
    """
    from sqlalchemy import func, select
    from sqlalchemy.orm import sessionmaker

    from app.inventory.models import Ingredient
    from app.recipes.models import Preparation, Recipe, RecipeLine
    from app.seed import seed

    engine = create_engine(migrated_url)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)

    def _conteos() -> dict[str, int]:
        with session_factory() as db:
            return {
                "ingredients": db.execute(select(func.count()).select_from(Ingredient)).scalar_one(),
                "preparations": db.execute(select(func.count()).select_from(Preparation)).scalar_one(),
                "recipes": db.execute(select(func.count()).select_from(Recipe)).scalar_one(),
                "recipe_lines": db.execute(select(func.count()).select_from(RecipeLine)).scalar_one(),
            }

    try:
        with session_factory() as db:
            seed(db)
        primera = _conteos()
        with session_factory() as db:
            seed(db)
        segunda = _conteos()
    finally:
        engine.dispose()

    assert primera["ingredients"] > 0, "el seed no carga insumos: la base sembrada no puede costear nada"
    assert primera["preparations"] > 0, "el seed no carga preparaciones: no se puede probar la producción rápida"
    assert primera["recipes"] > 0 and primera["recipe_lines"] > 0, (
        "el seed no carga fichas técnicas: enviar un plato no va a descontar nada"
    )
    assert primera == segunda, f"el seed duplicó datos al correr dos veces: {primera} -> {segunda}"


def test_a3_a_tip_payout_that_predates_the_column_reads_back_as_unknown(tmp_path: Path) -> None:
    """**El respaldo de `0021` tiene que producir un valor que el modelo sepa
    leer.** Suena obvio y casi rompe el deploy.

    `_enum(...)` (`app/shifts/models.py`) construye
    `sa.Enum(pyenum, native_enum=False)`, y SQLAlchemy guarda el **NOMBRE** del
    miembro, no su `.value`: la columna contiene `UNKNOWN`, no `unknown`. La
    primera versión de `0021` sembró `"unknown"`, y **toda fila respaldada
    reventaba al leerse** con `LookupError: 'unknown' is not among the defined
    enum values`.

    Ningún otro test lo veía, y no por descuido: **todos crean repartos por la
    API**, que escribe la columna a través del ORM y por lo tanto siempre
    acierta. El único camino que pasa por el `server_default` es el de una fila
    que ya existía cuando la columna se agregó — y ése sólo se recorre
    corriendo la cadena por la mitad, insertando, y siguiendo.

    Es la misma familia que el `batch_alter_table` que dejó la fase 2 sin
    desplegar: **código que sólo se ejecuta en bases que ya tienen datos, y que
    ninguna suite sobre bases vacías puede tocar.**
    """
    import sqlite3

    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import Session

    from app.shifts.models import TipPayout, TipPayoutSource

    db_path = tmp_path / "backfill-0021.db"
    url = f"sqlite:///{db_path}"

    # La cadena hasta JUSTO ANTES de la columna.
    previo = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = url
    try:
        command.upgrade(_alembic_config(url), "0020")

        # Una fila como las que ya existen en una base viva.
        con = sqlite3.connect(db_path)
        con.execute(
            "INSERT INTO tip_payouts (organization_id, store_id, shift_ids, paid_at, method,"
            " total_amount, created_by_employee_id, created_by_employee_name, created_at)"
            " VALUES (1, 1, '[]', '2026-01-01T00:00:00+00:00', 'cash', 5000, 1, 'Alguien',"
            " '2026-01-01T00:00:00+00:00')"
        )
        con.commit()
        con.close()

        # Y ahora la migración que agrega la columna sobre esa fila.
        command.upgrade(_alembic_config(url), "0021")

        engine = create_engine(url)
        try:
            with Session(engine) as session:
                fila = session.execute(select(TipPayout)).scalar_one()
                assert fila.paid_from is TipPayoutSource.UNKNOWN, (
                    f"el respaldo dejó {fila.paid_from!r}: el modelo no lo puede leer. El "
                    "`server_default` tiene que escribir el NOMBRE del miembro del enum "
                    "(`UNKNOWN`), que es lo que `sa.Enum(..., native_enum=False)` guarda"
                )
        finally:
            engine.dispose()
    finally:
        if previo is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previo
