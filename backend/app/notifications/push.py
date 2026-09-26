"""Avisos al celular (Web Push, función `notifications.push`, 0031).

Lo grave llega al teléfono del dueño aunque no tenga el admin abierto. La
única puerta sigue siendo `service.notify`: cuando crea una notificación de
nivel **crítico** (el nivel ya pasado por la regla de la sede) y la función
está encendida para esa sede, `enqueue` arma un envío por cada celular activo
de los administradores de la organización —y de los supervisores de la sede
si el llamador mandó un texto para ellos (`supervisor_body`, que nunca lleva
montos)—.

**Nunca frena la request.** `enqueue` sólo deja los envíos colgados de la
sesión (`Session.info`); salen **después del commit** (evento `after_commit`)
en un hilo aparte, con timeout por envío. Si la transacción se revierte, no
sale nada. Un 404/410 del servicio de push quiere decir que ese celular ya
no existe: la suscripción se da de baja (`revoked_at`, nunca se borra). Toda
otra falla se registra en el log y en `last_error`, y nunca levanta.

**Sin repetir**: `notify` ya deduplica por día con `dedupe_key`; además, un
aviso igual (mismo tipo y misma llave, o mismo título si no hay llave) no
vuelve a salir al celular antes de `PUSH_DEDUPE_MINUTES`.

**Claves VAPID**: si `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY` vienen por
entorno, mandan; si no, cada organización genera su par la primera vez que
alguien lo pide y lo guarda en `push_vapid_keys`. La privada no sale por
ninguna respuesta. Una suscripción guarda la pública con la que se hizo: si
la del servidor cambia, se da de baja (`key_changed`) y la pantalla pide
volver a activar.

**Sin dependencias nuevas.** El cifrado del contenido (RFC 8291,
`aes128gcm`) y la firma VAPID (RFC 8292, ES256) se hacen con `cryptography`
y `PyJWT`, que ya están fijadas en `requirements.txt`; el envío, con
`urllib`. `pywebpush` pide `cryptography>=47` (acá está fijada en 46 por un
motivo declarado) y arrastra `aiohttp`, y `http-ece` no construye su rueda
en todos los hosts.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import struct
import threading
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal
from urllib.parse import urlsplit

import jwt
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy import event, select
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.deps import Actor
from app.auth.models import Employee
from app.core import clock, features
from app.core.config import settings
from app.core.errors import AppError, NotFoundError
from app.notifications.models import Notification, PushSubscription, PushVapidKey

logger = logging.getLogger(__name__)

FEATURE = "notifications.push"
#: Un aviso igual no vuelve a salir al celular antes de esto.
PUSH_DEDUPE_MINUTES = 30
#: Tope de espera por envío: un servicio de push lento no cuelga el hilo.
PUSH_TIMEOUT_SECONDS = 10
#: Cuánto guarda el servicio de push un aviso para un celular apagado.
PUSH_TTL_SECONDS = 12 * 3600
#: A dónde lleva tocar el aviso si el llamador no dice otra cosa.
DEFAULT_URL = "/admin/hoy"
#: El contenido cifrado entra en un solo registro de 4096 bytes.
_RECORD_SIZE = 4096
_MAX_BODY_CHARS = 600

#: Servicios de push que se aceptan como destino (el servidor les hace un
#: POST: una lista cerrada evita que alguien lo use para llamar a otra cosa).
ALLOWED_PUSH_HOST_SUFFIXES = (
    ".googleapis.com",  # Chrome, Edge en Android, Brave, Opera, Samsung
    ".mozilla.com",  # Firefox
    ".push.apple.com",  # Safari (macOS e iPhone con la app en la pantalla de inicio)
    ".notify.windows.com",  # Edge en Windows
)

_PENDING_KEY = "push_jobs"


# ---------------------------------------------------------------------------
# base64url
# ---------------------------------------------------------------------------


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    value = value.strip()
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


# ---------------------------------------------------------------------------
# Claves VAPID
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VapidKeys:
    public_key: str  # punto P-256 sin comprimir, base64url (65 bytes)
    private_key: str  # escalar privado, base64url (32 bytes)
    source: Literal["env", "db"]


def _public_from_private(private: ec.EllipticCurvePrivateKey) -> str:
    raw = private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return _b64url(raw)


def _private_to_b64(private: ec.EllipticCurvePrivateKey) -> str:
    return _b64url(private.private_numbers().private_value.to_bytes(32, "big"))


def _load_private(value: str) -> ec.EllipticCurvePrivateKey:
    """La privada en base64url (32 bytes) o en PEM."""
    value = value.strip()
    if "BEGIN" in value:
        key = serialization.load_pem_private_key(value.encode("ascii"), password=None)
        if not isinstance(key, ec.EllipticCurvePrivateKey):
            raise ValueError("VAPID_PRIVATE_KEY no es una clave de curva elíptica")
        return key
    return ec.derive_private_key(int.from_bytes(_b64url_decode(value), "big"), ec.SECP256R1())


def generate_vapid_keys() -> tuple[str, str]:
    """`(pública, privada)` en base64url."""
    private = ec.generate_private_key(ec.SECP256R1())
    return _public_from_private(private), _private_to_b64(private)


def vapid_keys(db: Session, organization_id: int) -> VapidKeys:
    """Las claves con las que firma esta organización: las del entorno si
    vienen las dos; si no, las suyas guardadas, generadas la primera vez."""
    if settings.VAPID_PUBLIC_KEY.strip() and settings.VAPID_PRIVATE_KEY.strip():
        private = _load_private(settings.VAPID_PRIVATE_KEY)
        return VapidKeys(
            public_key=settings.VAPID_PUBLIC_KEY.strip(), private_key=_private_to_b64(private), source="env"
        )
    stmt = select(PushVapidKey).where(PushVapidKey.organization_id == organization_id)
    row = db.execute(stmt).scalar_one_or_none()
    if row is None:
        public, private_b64 = generate_vapid_keys()
        try:
            with db.begin_nested():
                row = PushVapidKey(
                    organization_id=organization_id,
                    public_key=public,
                    private_key=private_b64,
                    created_at=clock.now_utc(),
                )
                db.add(row)
                db.flush()
        except IntegrityError:
            # Dos requests a la vez: gana la primera y la otra relee.
            row = db.execute(stmt).scalar_one()
    return VapidKeys(public_key=row.public_key, private_key=row.private_key, source="db")


def _subject(db: Session, organization_id: int) -> str:
    if settings.VAPID_SUBJECT.strip():
        return settings.VAPID_SUBJECT.strip()
    email = db.execute(
        select(Employee.email)
        .where(
            Employee.organization_id == organization_id,
            Employee.role == "admin",
            Employee.active.is_(True),
            Employee.email.is_not(None),
        )
        .order_by(Employee.id)
        .limit(1)
    ).scalar_one_or_none()
    return f"mailto:{email}" if email else "mailto:avisos@example.com"


# ---------------------------------------------------------------------------
# Cifrado (RFC 8291, aes128gcm) y firma (RFC 8292)
# ---------------------------------------------------------------------------


def encrypt_payload(plaintext: bytes, *, p256dh: str, auth: str) -> bytes:
    """El cuerpo cifrado de un aviso para ese navegador: encabezado
    `aes128gcm` (sal, tamaño de registro, clave pública efímera) + un solo
    registro con el delimitador final."""
    ua_public = _b64url_decode(p256dh)
    auth_secret = _b64url_decode(auth)
    ephemeral = ec.generate_private_key(ec.SECP256R1())
    as_public = ephemeral.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    shared = ephemeral.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public))
    ikm = HKDF(
        algorithm=hashes.SHA256(), length=32, salt=auth_secret, info=b"WebPush: info\x00" + ua_public + as_public
    ).derive(shared)
    salt = os.urandom(16)
    cek = HKDF(algorithm=hashes.SHA256(), length=16, salt=salt, info=b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(algorithm=hashes.SHA256(), length=12, salt=salt, info=b"Content-Encoding: nonce\x00").derive(ikm)
    ciphertext = AESGCM(cek).encrypt(nonce, plaintext + b"\x02", None)
    header = salt + struct.pack("!I", _RECORD_SIZE) + bytes([len(as_public)]) + as_public
    return header + ciphertext


def vapid_authorization(endpoint: str, *, public_key: str, private_key: str, subject: str) -> str:
    parts = urlsplit(endpoint)
    claims = {
        "aud": f"{parts.scheme}://{parts.netloc}",
        "exp": int((clock.now_utc() + timedelta(hours=12)).timestamp()),
        "sub": subject,
    }
    token = jwt.encode(claims, _load_private(private_key), algorithm="ES256")
    return f"vapid t={token}, k={public_key}"


# ---------------------------------------------------------------------------
# Envío
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PushJob:
    subscription_id: int
    endpoint: str
    p256dh: str
    auth: str
    payload: bytes
    public_key: str
    private_key: str
    subject: str


@dataclass(frozen=True)
class PushResult:
    subscription_id: int
    outcome: Literal["sent", "gone", "failed"]
    detail: str | None = None


def _post(url: str, *, headers: dict[str, str], body: bytes, timeout: float) -> int:
    """El POST al servicio de push. Devuelve el código HTTP. Los tests lo
    reemplazan: nunca sale un aviso real desde la suite."""
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 (host validado al suscribir)
            return int(response.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)


def send_one(job: PushJob) -> PushResult:
    """Cifra, firma y manda un aviso. Nunca levanta."""
    try:
        body = encrypt_payload(job.payload, p256dh=job.p256dh, auth=job.auth)
        headers = {
            "Authorization": vapid_authorization(
                job.endpoint, public_key=job.public_key, private_key=job.private_key, subject=job.subject
            ),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": str(PUSH_TTL_SECONDS),
            "Urgency": "high",
        }
        status = _post(job.endpoint, headers=headers, body=body, timeout=PUSH_TIMEOUT_SECONDS)
    except Exception as exc:  # noqa: BLE001 — un aviso que no sale nunca tumba nada
        logger.warning("web push: falló el envío a la suscripción %s: %s", job.subscription_id, type(exc).__name__)
        return PushResult(job.subscription_id, "failed", type(exc).__name__)
    if status in (200, 201, 202):
        return PushResult(job.subscription_id, "sent")
    if status in (404, 410):
        return PushResult(job.subscription_id, "gone", f"HTTP {status}")
    logger.warning("web push: la suscripción %s respondió HTTP %s", job.subscription_id, status)
    return PushResult(job.subscription_id, "failed", f"HTTP {status}")


def deliver(jobs: list[PushJob]) -> list[PushResult]:
    return [send_one(job) for job in jobs]


def record_results(db: Session, results: list[PushResult]) -> None:
    """Deja en cada suscripción cómo le fue: 404/410 la da de baja."""
    now = clock.now_utc()
    for result in results:
        sub = db.get(PushSubscription, result.subscription_id)
        if sub is None:
            continue
        if result.outcome == "sent":
            sub.last_success_at = now
            sub.last_error = None
        elif result.outcome == "gone":
            sub.last_error = result.detail
            if sub.revoked_at is None:
                sub.revoked_at = now
                sub.revoked_reason = "gone"
        else:
            sub.last_error = (result.detail or "error")[:200]
    db.flush()


def _deliver_in_background(jobs: list[PushJob], bind: Engine | Connection) -> None:
    try:
        results = deliver(jobs)
        with Session(bind=bind) as session:
            record_results(session, results)
            session.commit()
    except Exception:  # noqa: BLE001 — el hilo de avisos nunca levanta
        logger.exception("web push: no se pudo registrar el resultado de los avisos")


def _spawn(target: Callable[[], None]) -> None:
    threading.Thread(target=target, name="web-push", daemon=True).start()


def pending_jobs(db: Session) -> list[PushJob]:
    """Lo encolado en esta sesión que todavía no salió (lo leen los tests)."""
    return list(db.info.get(_PENDING_KEY, []))


def flush_pending(db: Session) -> list[PushResult]:
    """Manda ya, en este hilo, lo encolado en la sesión, y registra el
    resultado en ella. Es lo que hace el commit en producción, sin el hilo:
    lo usan los tests, cuya sesión nunca comitea de verdad."""
    jobs = db.info.pop(_PENDING_KEY, [])
    results = deliver(jobs)
    record_results(db, results)
    return results


@event.listens_for(Session, "after_commit")
def _after_commit(session: Session) -> None:
    jobs = session.info.pop(_PENDING_KEY, None)
    if not jobs:
        return
    bind = session.get_bind()
    _spawn(lambda: _deliver_in_background(jobs, bind))


@event.listens_for(Session, "after_rollback")
def _after_rollback(session: Session) -> None:
    session.info.pop(_PENDING_KEY, None)


# ---------------------------------------------------------------------------
# Encolar desde `notify`
# ---------------------------------------------------------------------------


def _payload(*, title: str, body: str, url: str, tag: str, notification_id: int | None) -> bytes:
    data: dict[str, Any] = {"title": title, "body": body[:_MAX_BODY_CHARS], "url": url, "tag": tag}
    if notification_id is not None:
        data["notification_id"] = notification_id
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


def _recently_pushed(db: Session, row: Notification, since: datetime) -> bool:
    stmt = select(Notification.id).where(
        Notification.organization_id == row.organization_id,
        Notification.store_id == row.store_id,
        Notification.type == row.type,
        Notification.id != row.id,
        Notification.pushed_at.is_not(None),
        Notification.pushed_at >= since,
    )
    if row.dedupe_key is not None:
        stmt = stmt.where(Notification.dedupe_key == row.dedupe_key)
    else:
        stmt = stmt.where(Notification.title == row.title)
    return db.execute(stmt.limit(1)).first() is not None


def _active_subscriptions(
    db: Session, *, organization_id: int, store_id: int | None, with_supervisors: bool
) -> list[tuple[PushSubscription, str]]:
    """`(suscripción, rol)` de los administradores activos de la
    organización y, si se pide, de los supervisores activos de la sede."""
    roles = ["admin", "supervisor"] if with_supervisors else ["admin"]
    rows = db.execute(
        select(PushSubscription, Employee.role, Employee.store_id)
        .join(Employee, Employee.id == PushSubscription.employee_id)
        .where(
            PushSubscription.organization_id == organization_id,
            PushSubscription.revoked_at.is_(None),
            Employee.organization_id == organization_id,
            Employee.active.is_(True),
            Employee.role.in_(roles),
        )
        .order_by(PushSubscription.id)
    ).all()
    out: list[tuple[PushSubscription, str]] = []
    for sub, role, employee_store in rows:
        if role == "supervisor" and employee_store != store_id:
            continue
        out.append((sub, role))
    return out


def _usable(db: Session, subs: list[PushSubscription], keys: VapidKeys) -> list[PushSubscription]:
    """Las que se hicieron con la clave vigente. Las otras ya no pueden
    recibir nada: se dan de baja (`key_changed`) para que la pantalla pida
    activar de nuevo."""
    now = clock.now_utc()
    usable: list[PushSubscription] = []
    for sub in subs:
        if sub.vapid_public_key == keys.public_key:
            usable.append(sub)
        elif sub.revoked_at is None:
            sub.revoked_at = now
            sub.revoked_reason = "key_changed"
    db.flush()
    return usable


def _job(sub: PushSubscription, *, payload: bytes, keys: VapidKeys, subject: str) -> PushJob:
    return PushJob(
        subscription_id=sub.id,
        endpoint=sub.endpoint,
        p256dh=sub.p256dh,
        auth=sub.auth,
        payload=payload,
        public_key=keys.public_key,
        private_key=keys.private_key,
        subject=subject,
    )


def enqueue(
    db: Session,
    row: Notification,
    *,
    supervisor_body: str | None = None,
    url: str | None = None,
) -> int:
    """Encola el aviso al celular de una notificación recién creada, si
    corresponde. Devuelve cuántos envíos quedaron encolados. Nunca levanta:
    un aviso al celular que no se pudo armar no puede tumbar la operación
    que lo disparó."""
    try:
        return _enqueue(db, row, supervisor_body=supervisor_body, url=url)
    except Exception:  # noqa: BLE001
        logger.exception("web push: no se pudo encolar el aviso de la notificación %s", row.id)
        return 0


def _enqueue(db: Session, row: Notification, *, supervisor_body: str | None, url: str | None) -> int:
    if row.level != "critical":
        return 0
    if not features.is_enabled(db, row.organization_id, row.store_id, FEATURE):
        return 0
    now = clock.now_utc()
    if _recently_pushed(db, row, now - timedelta(minutes=PUSH_DEDUPE_MINUTES)):
        return 0
    pairs = _active_subscriptions(
        db, organization_id=row.organization_id, store_id=row.store_id, with_supervisors=supervisor_body is not None
    )
    if not pairs:
        return 0
    keys = vapid_keys(db, row.organization_id)
    usable = {s.id for s in _usable(db, [s for s, _ in pairs], keys)}
    if not usable:
        return 0
    subject = _subject(db, row.organization_id)
    tag = f"{row.type}:{row.dedupe_key or row.id}"
    target = url or DEFAULT_URL
    for_admin = _payload(title=row.title, body=row.body, url=target, tag=tag, notification_id=row.id)
    for_supervisor = (
        _payload(title=row.title, body=supervisor_body, url="/pos", tag=tag, notification_id=None)
        if supervisor_body is not None
        else None
    )
    jobs: list[PushJob] = []
    for sub, role in pairs:
        if sub.id not in usable:
            continue
        payload = for_supervisor if role == "supervisor" else for_admin
        if payload is None:
            continue
        jobs.append(_job(sub, payload=payload, keys=keys, subject=subject))
    if not jobs:
        return 0
    row.pushed_at = now
    db.flush()
    db.info.setdefault(_PENDING_KEY, []).extend(jobs)
    return len(jobs)


# ---------------------------------------------------------------------------
# Suscripciones (lo que usa la pantalla «Avisos al celular»)
# ---------------------------------------------------------------------------


def _validate_endpoint(endpoint: str) -> str:
    endpoint = endpoint.strip()
    parts = urlsplit(endpoint)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host or len(endpoint) > 1000:
        raise AppError(
            "PUSH_ENDPOINT_INVALID",
            "El navegador entregó una suscripción que no sirve: tocá «Activar en este celular» otra vez",
        )
    if not any(host.endswith(suffix) or f".{host}" == suffix for suffix in ALLOWED_PUSH_HOST_SUFFIXES):
        raise AppError(
            "PUSH_ENDPOINT_UNSUPPORTED",
            "Este navegador usa un servicio de avisos que el sistema no reconoce: activalos desde Chrome, "
            "Safari, Firefox o Edge",
        )
    return endpoint


def _validate_keys(p256dh: str, auth: str) -> None:
    try:
        point = _b64url_decode(p256dh)
        secret = _b64url_decode(auth)
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), point)
    except Exception:  # noqa: BLE001 — cualquier forma rota es la misma respuesta
        point, secret = b"", b""
    if len(point) != 65 or len(secret) != 16:
        raise AppError(
            "PUSH_KEYS_INVALID",
            "El navegador entregó claves de aviso que no sirven: tocá «Activar en este celular» otra vez",
        )


def list_devices(db: Session, actor: Actor) -> list[PushSubscription]:
    assert actor.employee_id is not None
    return list(
        db.execute(
            select(PushSubscription)
            .where(
                PushSubscription.organization_id == actor.organization_id,
                PushSubscription.employee_id == actor.employee_id,
                PushSubscription.revoked_at.is_(None),
            )
            .order_by(PushSubscription.created_at.desc(), PushSubscription.id.desc())
        ).scalars()
    )


def subscribe(
    db: Session,
    actor: Actor,
    *,
    endpoint: str,
    p256dh: str,
    auth: str,
    user_agent: str | None,
) -> PushSubscription:
    """Activa este celular para la persona. Todo se valida antes de
    escribir. El mismo celular otra vez no duplica: si ya estaba activo con
    las mismas claves se devuelve el que había; si cambió algo (otra
    persona, claves nuevas, la clave del servidor), el anterior se da de baja
    y queda el nuevo."""
    assert actor.employee_id is not None
    endpoint = _validate_endpoint(endpoint)
    p256dh, auth = p256dh.strip(), auth.strip()
    _validate_keys(p256dh, auth)
    keys = vapid_keys(db, actor.organization_id)
    now = clock.now_utc()
    existing = db.execute(
        select(PushSubscription)
        .where(PushSubscription.endpoint == endpoint, PushSubscription.revoked_at.is_(None))
        .with_for_update()
    ).scalar_one_or_none()
    if existing is not None:
        same = (
            existing.organization_id == actor.organization_id
            and existing.employee_id == actor.employee_id
            and existing.p256dh == p256dh
            and existing.auth == auth
            and existing.vapid_public_key == keys.public_key
        )
        if same:
            return existing
        existing.revoked_at = now
        existing.revoked_reason = "replaced"
        db.flush()
    sub = PushSubscription(
        organization_id=actor.organization_id,
        employee_id=actor.employee_id,
        endpoint=endpoint,
        p256dh=p256dh,
        auth=auth,
        vapid_public_key=keys.public_key,
        user_agent=(user_agent or "")[:300] or None,
        created_at=now,
    )
    try:
        with db.begin_nested():
            db.add(sub)
            db.flush()
    except IntegrityError:
        # Dos «Activar» del mismo celular a la vez: el índice único deja
        # entrar a uno y éste devuelve el que ganó (nunca dos filas vivas).
        return db.execute(
            select(PushSubscription).where(
                PushSubscription.endpoint == endpoint, PushSubscription.revoked_at.is_(None)
            )
        ).scalar_one()
    return sub


def _own_subscription(db: Session, actor: Actor, subscription_id: int) -> PushSubscription:
    sub = db.get(PushSubscription, subscription_id)
    if sub is None or sub.organization_id != actor.organization_id or sub.employee_id != actor.employee_id:
        raise NotFoundError("Ese celular no está en tu lista")
    return sub


def unsubscribe(
    db: Session, actor: Actor, *, subscription_id: int | None = None, endpoint: str | None = None
) -> PushSubscription | None:
    """«Quitar»: da de baja (nunca borra) un celular de la persona, por id
    (la lista) o por endpoint (el navegador que se desuscribe solo)."""
    if subscription_id is not None:
        sub: PushSubscription | None = _own_subscription(db, actor, subscription_id)
    elif endpoint is not None:
        sub = db.execute(
            select(PushSubscription).where(
                PushSubscription.endpoint == endpoint.strip(),
                PushSubscription.organization_id == actor.organization_id,
                PushSubscription.employee_id == actor.employee_id,
                PushSubscription.revoked_at.is_(None),
            )
        ).scalar_one_or_none()
    else:
        raise AppError("VALIDATION_ERROR", "Decí qué celular quitar")
    if sub is None or sub.revoked_at is not None:
        return None
    sub.revoked_at = clock.now_utc()
    sub.revoked_reason = "removed"
    db.flush()
    return sub


@dataclass(frozen=True)
class TestOutcome:
    sent: int
    failed: int
    removed: int


def send_test(db: Session, actor: Actor) -> TestOutcome:
    """«Enviar aviso de prueba» a todos los celulares activos de la persona.
    Sale en el momento (la persona está mirando la pantalla y quiere saber
    si llegó), con el mismo timeout por envío."""
    subs = list_devices(db, actor)
    if not subs:
        raise AppError(
            "PUSH_NO_DEVICES",
            "Todavía no hay ningún celular activo: tocá «Activar en este celular» desde el teléfono",
        )
    keys = vapid_keys(db, actor.organization_id)
    usable = _usable(db, subs, keys)
    subject = _subject(db, actor.organization_id)
    payload = _payload(
        title="Aviso de prueba",
        body="Si ves esto, los avisos graves van a llegar a este celular.",
        url=DEFAULT_URL,
        tag="push_test",
        notification_id=None,
    )
    results = deliver([_job(sub, payload=payload, keys=keys, subject=subject) for sub in usable])
    record_results(db, results)
    return TestOutcome(
        sent=sum(1 for r in results if r.outcome == "sent"),
        failed=sum(1 for r in results if r.outcome == "failed"),
        removed=sum(1 for r in results if r.outcome == "gone") + (len(subs) - len(usable)),
    )


def device_label(user_agent: str | None) -> str:
    """«iPhone · Safari»: para que la persona reconozca cada celular de su
    lista sin leer un user agent."""
    ua = (user_agent or "").lower()
    if "iphone" in ua:
        system = "iPhone"
    elif "ipad" in ua:
        system = "iPad"
    elif "android" in ua:
        system = "Android"
    elif "windows" in ua:
        system = "Windows"
    elif "mac os" in ua or "macintosh" in ua:
        system = "Mac"
    elif "linux" in ua:
        system = "Linux"
    else:
        system = "Dispositivo"
    if "edg/" in ua or "edga/" in ua or "edgios/" in ua:
        browser = "Edge"
    elif "firefox/" in ua or "fxios/" in ua:
        browser = "Firefox"
    elif "chrome/" in ua or "crios/" in ua:
        browser = "Chrome"
    elif "safari/" in ua:
        browser = "Safari"
    else:
        browser = None
    return f"{system} · {browser}" if browser else system
