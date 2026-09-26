"""Forma de `DocumentPrintableOut`; leyenda y tipo según `fiscal.dee_pos`;
reimpresión contada; `GET /documents/last`; lista admin y `format=csv`; 404
cruzando sede/organización; ninguna respuesta de dispositivo con
`cost`/`margin`/`unit_cost`.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from tests.payments.conftest import idem_headers

NO_TIP = {"asked": True, "accepted": False, "modified": False, "amount": 0}


def test_document_printable_shape_and_legend_pos_equivalent(
    device_client: TestClient, paid_order: Any
) -> None:
    payment = paid_order(tip=NO_TIP)
    document_id = payment["document"]["id"]

    resp = device_client.get(f"/api/v1/documents/{document_id}")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["document_type"] == "pos_equivalent"
    assert body["dian_status"] == "pending"
    assert body["legend"] == "DOCUMENTO PENDIENTE DE TRANSMISIÓN A LA DIAN"
    assert body["full_number"].startswith("POS-")
    # 1b-2: `fiscal` ahora trae el rango vigente que amparó el consecutivo
    # (A-11 — la leyenda depende del estado DIAN, acá `pending` porque el
    # `PendingTransmissionProvider` de esta fase nunca transmite de verdad).
    assert body["fiscal"]["dian_status"] == "pending"
    assert body["fiscal"]["contingency"] is False
    assert body["fiscal"]["cude"] is None
    assert body["fiscal"]["qr_url"] is None
    assert body["fiscal"]["range"]["prefix"] == "POS"
    # Se suman `doc_type_label` y `final_consumer` (cobro en tablet: el papel
    # decía «13 / 222222222222»); lo que ya estaba no cambia.
    assert body["customer"] == {
        "doc_type": "13",
        "doc_type_label": "C.C.",
        "final_consumer": True,
        "doc_number": "222222222222",
        "name": "Consumidor final",
        "email": None,
        "address": None,
        "municipality_dane": None,
    }
    assert body["print_count"] == 1
    assert body["reprint_count"] == 0
    assert body["reprints"] == []
    assert isinstance(body["lines"], list) and len(body["lines"]) == 1
    assert body["order"]["charged_by"] == "Cashier"
    assert body["order"]["served_by"] == "Cashier"

    raw = json.dumps(body)
    for forbidden in ("\"cost\"", "\"margin\"", "\"unit_cost\""):
        assert forbidden not in raw


def test_document_type_and_legend_follow_fiscal_dee_pos_flag(
    device_client: TestClient, set_feature: Any, paid_order: Any
) -> None:
    set_feature("fiscal.dee_pos", False)
    payment = paid_order(tip=NO_TIP)
    document_id = payment["document"]["id"]

    resp = device_client.get(f"/api/v1/documents/{document_id}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["document_type"] == "internal_receipt"
    assert body["dian_status"] is None
    assert body["legend"] == "COMPROBANTE INTERNO — no es factura ni documento equivalente"


def test_reprint_is_counted(device_client: TestClient, paid_order: Any) -> None:
    payment = paid_order(tip=NO_TIP)
    document_id = payment["document"]["id"]

    first = device_client.post(f"/api/v1/documents/{document_id}/reprint", headers=idem_headers())
    assert first.status_code == 200, first.text
    assert first.json()["reprint_count"] == 1
    assert len(first.json()["reprints"]) == 1
    assert first.json()["reprints"][0]["by"] == "Cashier"
    assert first.json()["print_count"] == 1  # nunca se toca: sólo cuenta reimpresiones

    second = device_client.post(f"/api/v1/documents/{document_id}/reprint", headers=idem_headers())
    assert second.status_code == 200, second.text
    assert second.json()["reprint_count"] == 2


def test_documents_last(device_client: TestClient, paid_order: Any) -> None:
    empty = device_client.get("/api/v1/documents/last")
    assert empty.status_code == 200, empty.text
    assert empty.json() is None

    payment = paid_order(tip=NO_TIP)
    last = device_client.get("/api/v1/documents/last")
    assert last.status_code == 200, last.text
    assert last.json()["id"] == payment["document"]["id"]


def test_admin_list_and_csv(admin_client: Any, store: Any, paid_order: Any) -> None:
    payment = paid_order(tip=NO_TIP)

    resp = admin_client.get(f"/api/v1/admin/documents?store_id={store.id}")
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert any(r["id"] == payment["document"]["id"] for r in rows)
    row = next(r for r in rows if r["id"] == payment["document"]["id"])
    assert row["full_number"] == payment["document"]["full_number"]
    assert row["charged_by"] == "Cashier"

    csv_resp = admin_client.get(f"/api/v1/admin/documents?store_id={store.id}&format=csv")
    assert csv_resp.status_code == 200, csv_resp.text
    assert csv_resp.headers["content-type"].startswith("text/csv")
    assert "full_number" in csv_resp.text


def test_document_404_across_stores(
    device_client: TestClient, admin_client: Any, paid_order: Any, store_b: Any, db: Any
) -> None:
    payment = paid_order(tip=NO_TIP)
    document_id = payment["document"]["id"]

    # Otro dispositivo, otra sede/organización: 404, nunca filtra por lista.
    from app.main import app

    other_device = TestClient(app)
    activate = other_device.post(
        "/api/v1/auth/device/activate", json={"store_id": store_b.id, "store_pin": "654321"}
    )
    assert activate.status_code == 200, activate.text
    resp = other_device.get(f"/api/v1/documents/{document_id}")
    assert resp.status_code == 404, resp.text
    assert resp.json()["error"]["code"] == "NOT_FOUND"


def test_openapi_device_responses_never_expose_cost_fields() -> None:
    """Ningún esquema alcanzable bajo una **sesión de dispositivo** declara un
    campo de costo o de margen (`AGENTS.md`: «el operador no recibe costos ni
    márgenes en ninguna respuesta de la API»; SPEC-NEGOCIO §11.10).

    HISTORIA DEL RECORTE, porque este guard ya costó plata dos veces
    (`outputs-2a/ENTREGA.md § 5`, R-9 y O-1; `spec.md § Invariantes heredados
    que 2b toca por diseño`).

    - **v1 (1b)**: serializaba `app.openapi()` ENTERO y buscaba el texto
      `"cost"`. Se llamaba «device responses» y no miraba ni rutas ni
      sesiones: prohibía el costo en TODO el producto. Era correcto sólo
      mientras el producto no tenía superficie de costo.
    - **El daño**: 2a existe para construir esa superficie. Como el guard era
      inesquivable y nadie estaba autorizado a cambiarlo, dos constructores
      renombraron campos del **contrato publicado** de `/admin/sales`
      (`theoretical_value` por `theoretical_cost`, `gross_contribution` por
      `gross_margin`, `recipe_coverage_pct` por `costed_pct`) con tal de
      pasarlo. El costo real no fue el test rojo: fue el contrato deformado.
    - **v2 (cierre de 2a)**: acotado a `"/admin/" not in path`, con
      coincidencia EXACTA de nombre (`cost`, `margin`, `unit_cost`,
      `food_cost`). Cerró el rojo, pero quedó con dos agujeros que 2b
      destapa: (a) el path no dice quién sirve la ruta — `POST /receptions`
      es admin puro (`current_admin`) y no lleva `/admin/` en el path, así
      que v2 lo acusa en falso por `ReceptionLineOut.unit_cost`; (b) la
      coincidencia exacta deja pasar `theoretical_cost`, `unit_cost_micros`
      o `gross_margin` en una ruta de dispositivo, que es exactamente el
      nombre que un rodeo elegiría.
    - **v3 (este, pedido 2b)**: el alcance se resuelve por **sesión**, no por
      texto del path. Una ruta es de admin si y sólo si su árbol de
      dependencias incluye `app.auth.deps.current_admin` (sin cookie de
      admin, ésa levanta 401 antes de entrar al endpoint). Todo lo demás
      bajo `/api/v1` es alcanzable con una sesión de dispositivo y entra al
      barrido. La coincidencia pasa a ser por **subcadena** (`cost`,
      `margin`), que es más estricta que v1 sobre el conjunto que sí manda.

    **Qué dejó de estar cubierto**: el costo en respuestas de administrador,
    que es precisamente lo que las fases 2a y 2b existen para construir, y que
    `tests/audit/test_reports_invariants.py::
    test_no_report_ever_exposes_a_cost_or_a_margin` sigue vigilando campo por
    campo con una lista blanca explícita por reporte. Que un dispositivo no
    llegue a esas rutas lo prueban
    `tests/audit/test_security_invariants.py::
    test_a_device_session_never_reaches_the_admin_routes_of_cost_and_inventory`
    y el invariante hermano de este archivo,
    `test_every_admin_path_is_served_only_under_an_admin_session`.
    """
    from tests.audit.conftest import (
        MONEY_LEAK_SUBSTRINGS,
        device_reachable_paths,
        openapi_properties_reachable_from,
    )

    from app.main import app

    device_paths = device_reachable_paths()
    assert len(device_paths) > 30, (
        "el barrido no encontró rutas de dispositivo: la clasificación por sesión se rompió "
        f"y estaría pasando por vacío (encontró {len(device_paths)})"
    )
    # Anclas: si alguna de estas deja de estar, el recorte se volvió inútil.
    for anchor in ("/api/v1/catalog", "/api/v1/orders/{order_id}", "/api/v1/device/ingredients", "/api/v1/waste"):
        assert anchor in device_paths, f"{anchor} salió del alcance del barrido de dispositivo"

    spec = app.openapi()
    leaked = [
        (where, prop)
        for where, prop in openapi_properties_reachable_from(spec, device_paths)
        if any(secret in prop.lower() for secret in MONEY_LEAK_SUBSTRINGS)
    ]
    assert not leaked, (
        "el OpenAPI declara campos de costo/margen alcanzables bajo sesión de dispositivo: "
        + "; ".join(f"{w} :: {p}" for w, p in sorted(leaked))
    )


def test_every_admin_path_is_served_only_under_an_admin_session() -> None:
    """La otra mitad del recorte: si el alcance del barrido de costo se
    resuelve por sesión, entonces «lo que está bajo `/admin/`» y «lo que exige
    `current_admin`» tienen que coincidir, o el recorte se podría ampliar solo
    con renombrar un path.

    Es además el invariante que hace **bloqueante** el punto 2 de
    `spec.md § Invariantes heredados que 2b toca por diseño`: la recepción
    lleva precios unitarios, así que es pantalla de administrador; si mañana
    aparece cualquier ruta de compras, conteos o lotes servida bajo sesión de
    dispositivo, este test la nombra antes de que el costo llegue a la tablet
    del salón.
    """
    from tests.audit.conftest import admin_only_paths, device_reachable_paths

    # `POST /api/v1/auth/admin/login` lleva `/admin/` en el path y es pública
    # por definición: es la puerta por la que se CONSIGUE la sesión de admin.
    PUBLIC_ADMIN_PATHS = {"/api/v1/auth/admin/login"}

    admin = admin_only_paths()
    device = device_reachable_paths()

    sin_guard = {p for p in device if "/admin/" in p} - PUBLIC_ADMIN_PATHS
    assert not sin_guard, (
        "rutas bajo /admin/ que NO exigen `current_admin` (un dispositivo las alcanza): " + str(sorted(sin_guard))
    )

    # El caso inverso no es un error, pero sí tiene que estar declarado: una
    # ruta de admin fuera de `/admin/` es una excepción del contrato y se
    # nombra acá para que nadie la agregue sin darse cuenta.
    DECLARED_ADMIN_PATHS_OUTSIDE_ADMIN_PREFIX = {
        # El contrato de 2b la fija literal así (`spec.md § API contract — 2b`,
        # "Receptions"); es admin igual (`current_admin` + `admin_store`).
        "/api/v1/receptions",
    }
    fuera = {p for p in admin if "/admin/" not in p}
    assert fuera == DECLARED_ADMIN_PATHS_OUTSIDE_ADMIN_PREFIX, (
        "cambió el conjunto de rutas de admin que no llevan /admin/ en el path: "
        f"{sorted(fuera)} (declaradas: {sorted(DECLARED_ADMIN_PATHS_OUTSIDE_ADMIN_PREFIX)})"
    )
