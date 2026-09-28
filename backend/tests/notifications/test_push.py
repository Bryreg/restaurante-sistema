"""Avisos al celular (Web Push, `notifications.push`, 0031).

Lo que se prueba, sin mandar nunca un aviso real (`push._post` se
reemplaza en todos los tests de este archivo):

- la clave pública VAPID se publica, es estable, y la privada nunca sale;
  las del entorno mandan sobre las guardadas;
- suscribir valida antes de escribir (servicio de push conocido, claves de
  navegador bien formadas), no duplica el mismo celular y «Quitar» da de
  baja sin borrar;
- «Enviar aviso de prueba» cuenta lo enviado y un 404/410 da de baja;
- `notify` crítico con la función encendida encola un envío por celular
  activo, que sale DESPUÉS del commit (nunca con un rollback), con el
  contenido cifrado para ese navegador; lo no crítico, la función apagada y
  un aviso igual hace menos de 30 minutos no salen;
- a los supervisores de la sede sólo les llega si el aviso trae un texto
  para ellos, y ése es el que les llega;
- la función apagada responde `FEATURE_DISABLED` en todas las rutas.

Excepción declarada a «todo entra por HTTP» (`CONTEXTO-AGENTES §11`): los
tests del despachador llaman a `notify` directo, que es la puerta real de
toda notificación; los hechos que la disparan desde cada dominio se prueban
por HTTP en sus dominios.
"""

from __future__ import annotations

import base64
import json
import os
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.models import Employee
from app.core.config import settings
from app.notifications import push
from app.notifications.models import Notification, NotificationRule, PushSubscription, PushVapidKey
from app.notifications.service import notify
from app.stores.models import Organization, Store

API = "/api/v1"
FCM = "https://fcm.googleapis.com/fcm/send/"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


@dataclass
class Browser:
    """Un navegador de mentira: sus claves, para poder descifrar lo que le
    llega como lo haría el de verdad."""

    endpoint: str
    private: ec.EllipticCurvePrivateKey = field(default_factory=lambda: ec.generate_private_key(ec.SECP256R1()))
    auth: bytes = field(default_factory=lambda: os.urandom(16))

    @property
    def p256dh(self) -> str:
        return _b64(
            self.private.public_key().public_bytes(
                serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
            )
        )

    def subscription(self) -> dict[str, Any]:
        return {"endpoint": self.endpoint, "keys": {"p256dh": self.p256dh, "auth": _b64(self.auth)}}

    def decrypt(self, body: bytes) -> dict[str, Any]:
        """RFC 8291 del lado del navegador."""
        salt, key_len = body[:16], body[20]
        server_public = body[21 : 21 + key_len]
        ciphertext = body[21 + key_len :]
        shared = self.private.exchange(
            ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), server_public)
        )
        ua_public = _unb64(self.p256dh)
        ikm = HKDF(
            algorithm=hashes.SHA256(), length=32, salt=self.auth, info=b"WebPush: info\x00" + ua_public + server_public
        ).derive(shared)
        cek = HKDF(algorithm=hashes.SHA256(), length=16, salt=salt, info=b"Content-Encoding: aes128gcm\x00").derive(ikm)
        nonce = HKDF(algorithm=hashes.SHA256(), length=12, salt=salt, info=b"Content-Encoding: nonce\x00").derive(ikm)
        plain = AESGCM(cek).decrypt(nonce, ciphertext, None)
        assert plain.endswith(b"\x02")
        return json.loads(plain[:-1].decode("utf-8"))


@dataclass
class FakePushService:
    """Reemplaza el POST real. `status` por endpoint (201 por defecto)."""

    status: dict[str, int] = field(default_factory=dict)
    calls: list[tuple[str, dict[str, str], bytes]] = field(default_factory=list)

    def __call__(self, url: str, *, headers: dict[str, str], body: bytes, timeout: float) -> int:
        assert timeout == push.PUSH_TIMEOUT_SECONDS
        self.calls.append((url, headers, body))
        return self.status.get(url, 201)


@pytest.fixture()
def push_service(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakePushService]:
    fake = FakePushService()
    monkeypatch.setattr(push, "_post", fake)
    # El hilo corre en línea: el test ve el resultado apenas vuelve el commit.
    monkeypatch.setattr(push, "_spawn", lambda target: target())
    monkeypatch.setattr(settings, "VAPID_PUBLIC_KEY", "")
    monkeypatch.setattr(settings, "VAPID_PRIVATE_KEY", "")
    monkeypatch.setattr(settings, "VAPID_SUBJECT", "")
    yield fake


def _subscribe(client: TestClient, browser: Browser, ua: str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)") -> Any:
    return client.post(f"{API}/admin/push/subscribe", json=browser.subscription(), headers={"User-Agent": ua})


def _critical(db: Session, org: Organization, store: Store, **kwargs: Any) -> Notification | None:
    data: dict[str, Any] = {
        "type": "shift_stale",
        "level": "critical",
        "title": "Turno sin cerrar",
        "body": "El turno #7 sigue abierto después de la hora de corte del día siguiente.",
        "dedupe_key": "shift_stale:7",
    }
    data.update(kwargs)
    return notify(db, organization_id=org.id, store_id=store.id, **data)


def _admin_sub(db: Session, org: Organization, employees: dict[str, Employee], browser: Browser) -> PushSubscription:
    """Una suscripción del administrador sembrada directo (tabla nueva: la
    ruta de suscribir tiene sus propios tests)."""
    return _sub_for(db, org, employees["admin"], browser)


def _sub_for(db: Session, org: Organization, employee: Employee, browser: Browser) -> PushSubscription:
    keys = push.vapid_keys(db, org.id)
    from app.core import clock

    sub = PushSubscription(
        organization_id=org.id,
        employee_id=employee.id,
        endpoint=browser.endpoint,
        p256dh=browser.p256dh,
        auth=_b64(browser.auth),
        vapid_public_key=keys.public_key,
        user_agent="Mozilla/5.0 (Linux; Android 14) Chrome/120",
        created_at=clock.now_utc(),
    )
    db.add(sub)
    db.commit()
    return sub


# ---------------------------------------------------------------------------
# Claves VAPID
# ---------------------------------------------------------------------------


def test_the_public_key_is_published_stable_and_the_private_never_leaves(
    db: Session, admin_client: TestClient, org: Organization, push_service: FakePushService
) -> None:
    first = admin_client.get(f"{API}/admin/push/public-key")
    assert first.status_code == 200, first.text
    public = first.json()["public_key"]
    assert len(_unb64(public)) == 65 and _unb64(public)[0] == 4
    assert admin_client.get(f"{API}/admin/push/public-key").json()["public_key"] == public
    row = db.execute(select(PushVapidKey).where(PushVapidKey.organization_id == org.id)).scalar_one()
    assert row.public_key == public
    assert set(first.json()) == {"public_key"}
    assert row.private_key not in first.text
    assert db.execute(select(func.count(PushVapidKey.id))).scalar_one() == 1


def test_keys_from_the_environment_win_over_the_stored_ones(
    db: Session, admin_client: TestClient, org: Organization, push_service: FakePushService, monkeypatch: pytest.MonkeyPatch
) -> None:
    public, private = push.generate_vapid_keys()
    monkeypatch.setattr(settings, "VAPID_PUBLIC_KEY", public)
    monkeypatch.setattr(settings, "VAPID_PRIVATE_KEY", private)
    resp = admin_client.get(f"{API}/admin/push/public-key")
    assert resp.json()["public_key"] == public
    assert db.execute(select(func.count(PushVapidKey.id))).scalar_one() == 0
    # La privada en PEM también sirve.
    pem = push._load_private(private).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    monkeypatch.setattr(settings, "VAPID_PRIVATE_KEY", pem.decode())
    assert push.vapid_keys(db, org.id).private_key == private


# ---------------------------------------------------------------------------
# Suscripciones
# ---------------------------------------------------------------------------


def test_subscribing_validates_before_writing(
    db: Session, admin_client: TestClient, push_service: FakePushService
) -> None:
    ajeno = Browser(endpoint="https://evil.example.com/push/1")
    resp = _subscribe(admin_client, ajeno)
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "PUSH_ENDPOINT_UNSUPPORTED"

    http = Browser(endpoint="http://fcm.googleapis.com/fcm/send/abc")
    assert _subscribe(admin_client, http).json()["error"]["code"] == "PUSH_ENDPOINT_INVALID"

    rotas = Browser(endpoint=FCM + "abc").subscription()
    rotas["keys"]["p256dh"] = _b64(b"no es un punto")
    resp = admin_client.post(f"{API}/admin/push/subscribe", json=rotas)
    assert resp.json()["error"]["code"] == "PUSH_KEYS_INVALID"

    assert db.execute(select(func.count(PushSubscription.id))).scalar_one() == 0


def test_the_same_phone_twice_is_one_device_and_removing_it_never_deletes(
    db: Session, admin_client: TestClient, employees: dict[str, Employee], push_service: FakePushService
) -> None:
    phone = Browser(endpoint=FCM + "phone-1")
    first = _subscribe(admin_client, phone)
    assert first.status_code == 200, first.text
    assert first.json()["label"] == "iPhone"
    again = _subscribe(admin_client, phone)
    assert again.json()["id"] == first.json()["id"]

    devices = admin_client.get(f"{API}/admin/push/devices").json()
    assert [d["id"] for d in devices] == [first.json()["id"]]

    # Claves nuevas del mismo celular: el anterior se da de baja, queda uno.
    renewed = Browser(endpoint=phone.endpoint)
    third = _subscribe(admin_client, renewed)
    assert third.json()["id"] != first.json()["id"]
    assert len(admin_client.get(f"{API}/admin/push/devices").json()) == 1

    removed = admin_client.post(f"{API}/admin/push/unsubscribe", json={"subscription_id": third.json()["id"]})
    assert removed.json() == {"removed": True}
    assert admin_client.get(f"{API}/admin/push/devices").json() == []
    assert admin_client.post(
        f"{API}/admin/push/unsubscribe", json={"subscription_id": third.json()["id"]}
    ).json() == {"removed": False}

    rows = db.execute(select(PushSubscription).order_by(PushSubscription.id)).scalars().all()
    assert len(rows) == 2, "nada se borra: las dos filas siguen"
    assert [r.revoked_reason for r in rows] == ["replaced", "removed"]


def test_a_device_of_someone_else_is_not_found(
    db: Session, admin_client: TestClient, org: Organization, employees: dict[str, Employee], push_service: FakePushService
) -> None:
    other = _sub_for(db, org, employees["supervisor"], Browser(endpoint=FCM + "sup"))
    resp = admin_client.post(f"{API}/admin/push/unsubscribe", json={"subscription_id": other.id})
    assert resp.status_code == 404
    db.refresh(other)
    assert other.revoked_at is None


# ---------------------------------------------------------------------------
# Aviso de prueba
# ---------------------------------------------------------------------------


def test_the_test_notice_reaches_my_phones_and_a_gone_phone_is_removed(
    db: Session, admin_client: TestClient, push_service: FakePushService
) -> None:
    sin = admin_client.post(f"{API}/admin/push/test")
    assert sin.status_code == 400
    assert sin.json()["error"]["code"] == "PUSH_NO_DEVICES"

    alive, gone = Browser(endpoint=FCM + "alive"), Browser(endpoint="https://web.push.apple.com/gone")
    assert _subscribe(admin_client, alive).status_code == 200
    assert _subscribe(admin_client, gone).status_code == 200
    push_service.status[gone.endpoint] = 410

    resp = admin_client.post(f"{API}/admin/push/test")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"sent": 1, "failed": 0, "removed": 1}

    url, headers, body = next(c for c in push_service.calls if c[0] == alive.endpoint)
    assert headers["Content-Encoding"] == "aes128gcm"
    assert headers["Authorization"].startswith("vapid t=")
    assert alive.decrypt(body)["title"] == "Aviso de prueba"

    devices = admin_client.get(f"{API}/admin/push/devices").json()
    assert [d["endpoint"] for d in devices] == [alive.endpoint]
    assert devices[0]["last_success_at"] is not None
    gone_row = db.execute(select(PushSubscription).where(PushSubscription.endpoint == gone.endpoint)).scalar_one()
    assert gone_row.revoked_reason == "gone"


# ---------------------------------------------------------------------------
# El despachador colgado de `notify`
# ---------------------------------------------------------------------------


def test_a_critical_notice_goes_out_after_commit_encrypted_for_each_phone(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], push_service: FakePushService
) -> None:
    phone = Browser(endpoint=FCM + "owner")
    _admin_sub(db, org, employees, phone)

    row = _critical(db, org, store)
    assert row is not None and row.pushed_at is not None
    assert len(push.pending_jobs(db)) == 1
    assert push_service.calls == [], "nada sale antes del commit"

    db.commit()
    assert push.pending_jobs(db) == []
    assert len(push_service.calls) == 1
    url, headers, body = push_service.calls[0]
    assert url == phone.endpoint
    assert headers["TTL"] and headers["Urgency"] == "high"
    message = phone.decrypt(body)
    assert message["title"] == "Turno sin cerrar"
    # Antes: "/admin/hoy". Cambio intencional (handoff «Aviso desde la
    # notificación»): tocar el aviso abre SU vista, marcada como abierta desde
    # una notificación; sin `push_url` no hay `destino` y la vista usa el del tipo.
    assert message["url"] == f"/admin/avisos/{row.id}?desde=notificacion"
    assert message["notification_id"] == row.id


def test_a_rollback_sends_nothing(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], push_service: FakePushService
) -> None:
    _admin_sub(db, org, employees, Browser(endpoint=FCM + "owner"))
    _critical(db, org, store)
    assert len(push.pending_jobs(db)) == 1
    db.rollback()
    assert push.pending_jobs(db) == []
    db.commit()
    assert push_service.calls == []


def test_a_gone_phone_is_revoked_by_the_background_delivery(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], push_service: FakePushService
) -> None:
    phone = Browser(endpoint=FCM + "old-phone")
    sub = _admin_sub(db, org, employees, phone)
    push_service.status[phone.endpoint] = 404
    _critical(db, org, store)
    db.commit()
    db.expire_all()
    refreshed = db.get(PushSubscription, sub.id)
    assert refreshed is not None
    assert refreshed.revoked_at is not None and refreshed.revoked_reason == "gone"


def test_a_failure_of_the_push_service_never_raises(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], monkeypatch: pytest.MonkeyPatch,
    push_service: FakePushService,
) -> None:
    sub = _admin_sub(db, org, employees, Browser(endpoint=FCM + "flaky"))

    def _boom(url: str, *, headers: dict[str, str], body: bytes, timeout: float) -> int:
        raise TimeoutError("sin respuesta")

    monkeypatch.setattr(push, "_post", _boom)
    _critical(db, org, store)
    db.commit()
    db.expire_all()
    refreshed = db.get(PushSubscription, sub.id)
    assert refreshed is not None
    assert refreshed.revoked_at is None, "una falla que no es 404/410 no da de baja"
    assert refreshed.last_error == "TimeoutError"


def test_what_is_not_critical_or_has_the_feature_off_does_not_go_out(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], set_feature: Any,
    push_service: FakePushService,
) -> None:
    _admin_sub(db, org, employees, Browser(endpoint=FCM + "owner"))
    warning = _critical(db, org, store, level="warning", type="cash_difference", dedupe_key="cash_difference:1")
    assert warning is not None and warning.pushed_at is None

    # La regla de la sede manda sobre el nivel: bajado a alerta, no sale.
    db.add(NotificationRule(organization_id=org.id, store_id=store.id, type="pin_locked", enabled=True, level="warning"))
    db.commit()
    ruled = _critical(db, org, store, type="pin_locked", dedupe_key="pin_locked:1")
    assert ruled is not None and ruled.level == "warning" and ruled.pushed_at is None

    set_feature("notifications.push", False, store_id=store.id)
    off = _critical(db, org, store, dedupe_key="shift_stale:99")
    assert off is not None and off.pushed_at is None
    assert push.pending_jobs(db) == []


def test_the_same_notice_does_not_go_out_twice_within_thirty_minutes(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], clock: Any,
    push_service: FakePushService,
) -> None:
    _admin_sub(db, org, employees, Browser(endpoint=FCM + "owner"))
    first = _critical(db, org, store, dedupe_key=None, type="cash_difference_critical", title="Diferencia crítica de caja")
    assert first is not None and first.pushed_at is not None
    clock.advance(minutes=10)
    second = _critical(db, org, store, dedupe_key=None, type="cash_difference_critical", title="Diferencia crítica de caja")
    assert second is not None and second.pushed_at is None
    clock.advance(minutes=25)
    third = _critical(db, org, store, dedupe_key=None, type="cash_difference_critical", title="Diferencia crítica de caja")
    assert third is not None and third.pushed_at is not None


def test_supervisors_only_get_it_when_it_brings_a_text_for_them(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], push_service: FakePushService
) -> None:
    owner, sup = Browser(endpoint=FCM + "owner"), Browser(endpoint=FCM + "sup")
    _admin_sub(db, org, employees, owner)
    _sub_for(db, org, employees["supervisor"], sup)

    _critical(db, org, store)
    assert [j.endpoint for j in push.pending_jobs(db)] == [owner.endpoint]
    db.commit()

    push_service.calls.clear()
    _critical(
        db, org, store, type="reserve_loan_open", title="Base de respaldo sin devolver",
        body="El turno #3 sigue debiendo $ 50.000 a la base de respaldo.", dedupe_key="reserve_loan_open:3",
        supervisor_body="El turno #3 no devolvió la plata de la base de respaldo.",
    )
    db.commit()
    by_endpoint = {url: body for url, _h, body in push_service.calls}
    assert owner.decrypt(by_endpoint[owner.endpoint])["body"].startswith("El turno #3 sigue debiendo $")
    for_sup = sup.decrypt(by_endpoint[sup.endpoint])
    assert "$" not in for_sup["body"] and "notification_id" not in for_sup


def test_a_supervisor_of_another_store_and_an_inactive_admin_get_nothing(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], push_service: FakePushService
) -> None:
    other_store = Store(
        organization_id=org.id, name="Otra", opening_hours=[], cutoff_hour=6, active_channels=["counter"],
        store_pin_hash="x", active=True, created_at=store.created_at, updated_at=store.updated_at,
    )
    db.add(other_store)
    db.flush()
    employees["supervisor"].store_id = other_store.id
    _sub_for(db, org, employees["supervisor"], Browser(endpoint=FCM + "sup"))
    _admin_sub(db, org, employees, Browser(endpoint=FCM + "owner"))
    employees["admin"].active = False
    db.commit()
    assert _critical(db, org, store, supervisor_body="Aviso sin montos.") is not None
    assert push.pending_jobs(db) == []


def test_a_phone_subscribed_with_an_old_key_is_revoked_and_skipped(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], push_service: FakePushService
) -> None:
    sub = _admin_sub(db, org, employees, Browser(endpoint=FCM + "owner"))
    sub.vapid_public_key = push.generate_vapid_keys()[0]
    db.commit()
    _critical(db, org, store)
    assert push.pending_jobs(db) == []
    db.refresh(sub)
    assert sub.revoked_reason == "key_changed"


def test_the_rules_screen_shows_the_critical_types_as_critical(
    admin_client: TestClient, store: Store, push_service: FakePushService
) -> None:
    rules = {r["type"]: r["level"] for r in admin_client.get(f"{API}/admin/notification-rules", params={"store_id": store.id}).json()}
    for tipo in ("shift_stale", "cash_difference_critical", "void_rate_high", "reserve_loan_open", "area_count_shortage"):
        assert rules[tipo] == "critical", tipo
    assert rules["cash_difference"] == "warning"


# ---------------------------------------------------------------------------
# Función apagada
# ---------------------------------------------------------------------------


def test_every_push_route_says_feature_disabled_with_the_feature_off(
    admin_client: TestClient, set_feature: Any, push_service: FakePushService
) -> None:
    set_feature("notifications.push", False)
    calls = [
        admin_client.get(f"{API}/admin/push/public-key"),
        admin_client.get(f"{API}/admin/push/devices"),
        admin_client.post(f"{API}/admin/push/subscribe", json=Browser(endpoint=FCM + "x").subscription()),
        admin_client.post(f"{API}/admin/push/unsubscribe", json={"subscription_id": 1}),
        admin_client.post(f"{API}/admin/push/test"),
    ]
    for resp in calls:
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "FEATURE_DISABLED"


def test_a_device_session_never_reaches_the_push_routes(device_client: TestClient, push_service: FakePushService) -> None:
    assert device_client.get(f"{API}/admin/push/public-key").status_code == 401
    assert device_client.post(f"{API}/admin/push/test").status_code == 401


def test_the_notice_opens_its_own_view_and_carries_the_screen_that_resolves_it(
    db: Session, org: Organization, store: Store, employees: dict[str, Employee], push_service: FakePushService
) -> None:
    phone = Browser(endpoint=FCM + "owner")
    _admin_sub(db, org, employees, phone)

    row = _critical(
        db, org, store, type="area_count_shortage", title="Faltante grande en el conteo",
        dedupe_key="area_count_shortage:9", push_url="/admin/inventario?tab=por-area",
    )
    assert row is not None
    db.commit()
    message = phone.decrypt(push_service.calls[0][2])
    assert message["url"] == (
        f"/admin/avisos/{row.id}?desde=notificacion&destino=%2Fadmin%2Finventario%3Ftab%3Dpor-area"
    )


def test_a_single_notice_is_read_by_id_and_another_organization_gets_404(
    admin_client: TestClient, db: Session, org: Organization, store: Store
) -> None:
    row = _critical(db, org, store)
    assert row is not None
    db.commit()

    got = admin_client.get(f"{API}/admin/notifications/{row.id}")
    assert got.status_code == 200
    body = got.json()
    assert body["id"] == row.id and body["store_id"] == store.id and body["level"] == "critical"
    assert body["read_at"] is None

    from app.core import clock as core_clock

    now = core_clock.now_utc()
    other = Organization(name="Otra", profile="full", created_at=now, updated_at=now)
    db.add(other)
    db.flush()
    # Directo a la tabla: lo que se prueba es la puerta de lectura, no `notify`.
    foreign = Notification(
        organization_id=other.id, store_id=store.id, type="pin_locked", level="warning",
        title="Ajena", body="De otra organización", created_at=now,
    )
    db.add(foreign)
    db.commit()
    assert admin_client.get(f"{API}/admin/notifications/{foreign.id}").status_code == 404
