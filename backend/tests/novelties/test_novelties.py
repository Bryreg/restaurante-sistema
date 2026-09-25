"""Novedades del turno (`app.novelties`, detrás de `pos.novelties`).

Todo entra por HTTP. Lo que se prueba: registrar (con foto y sin ella), que
la que requiere seguimiento pasa al turno siguiente y la informativa no, que
una urgente siempre pasa, resolver (una sola vez, con nota, desde el POS o
desde el admin), permisos (persona identificada para escribir, sede ajena es
404) y la función apagada.
"""

from __future__ import annotations

import base64
from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit.models import AuditLog
from app.auth.models import Employee
from app.core.money import DENOMINATIONS
from app.novelties import hooks
from app.novelties.models import Novelty
from app.photos.models import Photo
from app.stores.models import Store

API = "/api/v1"
FOTO = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff\xe0 foto de la nevera").decode()


def _idem() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid4())}


def _denoms(total: int) -> dict[str, Any]:
    rest = total
    items: list[dict[str, int]] = []
    for value in sorted(DENOMINATIONS, reverse=True):
        count, rest = divmod(rest, value)
        if count:
            items.append({"value": value, "count": count})
    return {"denominations": items, "total": total}


def _close_shift(device_client: TestClient, shift_id: int) -> None:
    """Cierre a ciegas por la puerta real, sin ventas: cuenta la base."""
    count = device_client.post(
        f"{API}/shifts/{shift_id}/close/count",
        json={"counted_cash": _denoms(200_000), "tips_cash_out": 0, "photo": "data:image/png;base64,AAAA"},
        headers=_idem(),
    )
    assert count.status_code == 201, count.text
    count_id = count.json()["count_id"]
    review = device_client.get(f"{API}/shifts/{shift_id}/close/{count_id}/review")
    assert review.status_code == 200, review.text
    diff = review.json()["difference"]
    extra: dict[str, Any] = {"cause": "unknown", "note": "cierre de prueba"} if diff != 0 else {}
    confirm = device_client.post(
        f"{API}/shifts/{shift_id}/close/{count_id}/confirm",
        json={"difference_seen": diff, "closes_day": True, **extra},
    )
    assert confirm.status_code == 200, confirm.text


def _post(device_client: TestClient, **overrides: Any) -> Any:
    body: dict[str, Any] = {
        "title": "Se dañó la nevera de bebidas",
        "detail": "No enfría desde las 3 pm",
        "category": "equipment",
        "level": "important",
        "requires_follow_up": True,
    }
    body.update(overrides)
    return device_client.post(f"{API}/novelties", json=body, headers=_idem())


def test_registrar_una_novedad_la_atribuye_a_la_persona_y_al_turno_abierto(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    open_shift: Callable[..., dict],
    db: Session,
) -> None:
    shift = open_shift()
    identify(device_client, employees["operator"])
    resp = _post(device_client, photo=FOTO)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["employee_name"] == "Operator"
    assert body["shift_id"] == shift["id"]
    assert body["open"] is True
    assert body["category"] == "equipment"
    # La foto pasa por `photos_hooks.store_photo`: queda en `photos`, no en la fila.
    assert body["photo"].startswith("/api/v1/photos/")
    assert db.execute(select(Photo)).scalars().first() is not None

    audit = db.execute(select(AuditLog).where(AuditLog.entity == "novelty")).scalars().all()
    assert [a.action for a in audit] == ["create"]


def test_se_registra_aunque_no_haya_turno_abierto(
    device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee]
) -> None:
    identify(device_client, employees["operator"])
    resp = _post(device_client)
    assert resp.status_code == 201, resp.text
    assert resp.json()["shift_id"] is None
    board = device_client.get(f"{API}/novelties/open").json()
    assert [n["id"] for n in board["this_shift"]] == [resp.json()["id"]]


def test_registrar_exige_persona_identificada(device_client: TestClient) -> None:
    resp = _post(device_client)
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "IDENTIFY_REQUIRED"


def test_titulo_en_blanco_se_rechaza_sin_escribir(
    device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee], db: Session
) -> None:
    identify(device_client, employees["operator"])
    resp = _post(device_client, title="   ")
    assert resp.status_code == 400
    assert db.execute(select(Novelty)).scalars().first() is None


def test_la_que_requiere_seguimiento_pasa_al_turno_siguiente_y_la_informativa_no(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    open_shift: Callable[..., dict],
) -> None:
    first = open_shift()
    identify(device_client, employees["operator"])
    follow = _post(device_client, requires_follow_up=True).json()
    info = _post(device_client, title="Llegó el pedido de gaseosas", level="info", requires_follow_up=False).json()
    assert info["open"] is False

    board = device_client.get(f"{API}/novelties/open").json()
    assert [n["id"] for n in board["open"]] == [follow["id"]]
    assert {n["id"] for n in board["this_shift"]} == {follow["id"], info["id"]}

    identify(device_client, employees["cashier"])
    _close_shift(device_client, first["id"])
    open_shift()

    board = device_client.get(f"{API}/novelties/open").json()
    # El turno nuevo ve la abierta del anterior; su propio registro está vacío.
    assert [n["id"] for n in board["open"]] == [follow["id"]]
    assert board["open_count"] == 1
    assert board["this_shift"] == []


def test_una_urgente_siempre_requiere_seguimiento_y_va_primero(
    device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee], db: Session, store: Store
) -> None:
    identify(device_client, employees["operator"])
    important = _post(device_client, level="important").json()
    urgent = _post(device_client, title="Fuga de gas", category="security", level="urgent", requires_follow_up=False).json()
    assert urgent["requires_follow_up"] is True

    board = device_client.get(f"{API}/novelties/open").json()
    assert [n["id"] for n in board["open"]] == [urgent["id"], important["id"]]

    assert hooks.open_count(db, store.id) == 2
    assert [u.id for u in hooks.urgent_open(db, store.id)] == [urgent["id"]]


def test_resolver_desde_el_pos_con_nota_la_cierra_una_sola_vez(
    device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee], db: Session
) -> None:
    identify(device_client, employees["operator"])
    novelty = _post(device_client).json()

    identify(device_client, employees["operator2"])
    sin_nota = device_client.post(f"{API}/novelties/{novelty['id']}/resolve", json={"note": "  "}, headers=_idem())
    assert sin_nota.status_code == 400
    assert db.get(Novelty, novelty["id"]).resolved_at is None  # type: ignore[union-attr]

    resp = device_client.post(
        f"{API}/novelties/{novelty['id']}/resolve", json={"note": "Vino el técnico, cambió el relé"}, headers=_idem()
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["open"] is False
    assert body["resolved_by_employee_name"] == "Operator2"
    assert body["resolution_note"] == "Vino el técnico, cambió el relé"

    again = device_client.post(f"{API}/novelties/{novelty['id']}/resolve", json={"note": "otra"}, headers=_idem())
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "NOVELTY_ALREADY_RESOLVED"

    board = device_client.get(f"{API}/novelties/open").json()
    assert board["open"] == []
    # Nada se borra: sigue en el registro del turno, resuelta.
    assert [n["id"] for n in board["this_shift"]] == [novelty["id"]]


def test_resolver_desde_el_pos_exige_persona_identificada(
    device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee], client: TestClient
) -> None:
    identify(device_client, employees["operator"])
    novelty = _post(device_client).json()
    device_client.post(f"{API}/auth/device/release")
    resp = device_client.post(f"{API}/novelties/{novelty['id']}/resolve", json={"note": "listo"}, headers=_idem())
    assert resp.status_code == 401


def test_el_admin_ve_las_abiertas_y_el_historico_y_resuelve(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    admin_client: TestClient,
    store: Store,
    db: Session,
) -> None:
    identify(device_client, employees["operator"])
    open_one = _post(device_client).json()
    info = _post(device_client, title="Todo normal", level="info", requires_follow_up=False).json()

    opens = admin_client.get(f"{API}/admin/novelties", params={"store_id": store.id, "status": "open"}).json()
    assert [n["id"] for n in opens] == [open_one["id"]]
    all_rows = admin_client.get(f"{API}/admin/novelties", params={"store_id": store.id, "status": "all"}).json()
    assert {n["id"] for n in all_rows} == {open_one["id"], info["id"]}

    resp = admin_client.post(
        f"{API}/admin/novelties/{open_one['id']}/resolve",
        params={"store_id": store.id},
        json={"note": "Se llamó al proveedor"},
        headers=_idem(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["resolved_by_employee_name"] == "Admin"
    assert admin_client.get(f"{API}/admin/novelties", params={"store_id": store.id}).json() == []

    csv = admin_client.get(f"{API}/admin/novelties", params={"store_id": store.id, "status": "all", "format": "csv"})
    assert csv.status_code == 200
    assert csv.headers["content-type"].startswith("text/csv")

    actions = [a.action for a in db.execute(select(AuditLog).where(AuditLog.entity == "novelty")).scalars()]
    assert sorted(actions) == ["create", "create", "resolve"]


def test_el_admin_filtra_el_historico_por_fecha(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    admin_client: TestClient,
    store: Store,
) -> None:
    identify(device_client, employees["operator"])
    novelty = _post(device_client).json()
    day = novelty["business_date"]
    same = admin_client.get(
        f"{API}/admin/novelties", params={"store_id": store.id, "status": "all", "from": day, "to": day}
    ).json()
    assert [n["id"] for n in same] == [novelty["id"]]
    before = admin_client.get(
        f"{API}/admin/novelties", params={"store_id": store.id, "status": "all", "to": "2000-01-01"}
    ).json()
    assert before == []


def test_la_novedad_de_otra_organizacion_es_404(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    admin_client: TestClient,
    store_b: Store,
    store: Store,
) -> None:
    identify(device_client, employees["operator"])
    novelty = _post(device_client).json()
    ajena = admin_client.get(f"{API}/admin/novelties", params={"store_id": store_b.id})
    assert ajena.status_code == 404
    resolve = admin_client.post(
        f"{API}/admin/novelties/{novelty['id']}/resolve",
        params={"store_id": store_b.id},
        json={"note": "x"},
        headers=_idem(),
    )
    assert resolve.status_code == 404


def test_el_dispositivo_no_llega_a_las_rutas_de_admin(
    device_client: TestClient, identify: Callable[..., Any], employees: dict[str, Employee], store: Store
) -> None:
    identify(device_client, employees["operator"])
    resp = device_client.get(f"{API}/admin/novelties", params={"store_id": store.id})
    assert resp.status_code == 401


def test_con_la_funcion_apagada_el_backend_corta(
    device_client: TestClient,
    identify: Callable[..., Any],
    employees: dict[str, Employee],
    admin_client: TestClient,
    set_feature: Callable[..., None],
    store: Store,
) -> None:
    identify(device_client, employees["operator"])
    set_feature("pos.novelties", False)
    for resp in (
        _post(device_client),
        device_client.get(f"{API}/novelties/open"),
        admin_client.get(f"{API}/admin/novelties", params={"store_id": store.id}),
    ):
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_la_funcion_viene_encendida_en_los_tres_perfiles() -> None:
    from app.core.features import FEATURE_BY_KEY

    assert FEATURE_BY_KEY["pos.novelties"].defaults == {"basic": True, "standard": True, "full": True}
