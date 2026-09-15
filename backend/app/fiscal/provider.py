"""Adaptador de proveedor tecnológico (SPEC-NEGOCIO §8.3; pedido 1b-2).

Interfaz interna (`FiscalProvider`): `emit(document)`, `retry(document)`,
`health()`. Dos implementaciones, ninguna es un proveedor real:

- `PendingTransmissionProvider` — la real de ESTA fase. El dueño todavía no
  eligió un proveedor tecnológico (Siigo, Alegra, Dataico...), así que el
  sistema sigue en modo "pendiente de transmisión": el documento se imprime
  con su leyenda y queda encolado. Nunca falla, nunca transmite nada.
- `FakeProvider` — sólo para tests: configurable para **validar**,
  **rechazar** o simular **contingencia**, con CUDE/QR sintéticos.

El punto entero de este archivo es que **elegir un proveedor real, el día de
mañana, sea escribir una tercera clase acá y cambiar `get_provider`** — nunca
tocar `app.payments.service.pay_order` ni `app.fiscal.service.issue_document`,
que sólo conocen la interfaz. Por eso ninguno de esos dos módulos importa
`PendingTransmissionProvider` ni `FakeProvider` por nombre fuera de este
archivo (lo prueba `tests/fiscal/test_provider.py`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, Protocol

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from app.fiscal.models import FiscalDocument
    from app.stores.models import Store

EmitStatus = Literal["pending", "sent", "validated", "rejected", "contingency"]


@dataclass(frozen=True)
class EmitResult:
    """Lo que devuelve `emit`/`retry`: el nuevo estado ante la DIAN más la
    evidencia que haya (todo `None`/vacío si no aplica todavía)."""

    status: EmitStatus
    cude: str | None = None
    qr_url: str | None = None
    xml_ref: str | None = None
    response: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ProviderHealth:
    ok: bool
    detail: str


class FiscalProvider(Protocol):
    """Contrato que cualquier proveedor (real o fake) tiene que cumplir."""

    def emit(self, document: "FiscalDocument") -> EmitResult: ...

    def retry(self, document: "FiscalDocument") -> EmitResult: ...

    def health(self) -> ProviderHealth: ...


class PendingTransmissionProvider:
    """El proveedor real de 1b-2 (SPEC-NEGOCIO §8.3): nadie transmite nada
    todavía. `emit`/`retry` son un no-op que confirma que el documento queda
    `pending`, impreso con su leyenda y encolado — nunca fallan, nunca
    bloquean una venta. El día que el dueño elija un proveedor tecnológico,
    esta clase se reemplaza (o se agrega una nueva y `get_provider` elige)
    sin tocar `pay_order` ni `issue_document`."""

    def emit(self, document: "FiscalDocument") -> EmitResult:
        del document
        return EmitResult(status="pending", response={"provider": "pending_transmission", "queued": True})

    def retry(self, document: "FiscalDocument") -> EmitResult:
        del document
        return EmitResult(
            status="pending", response={"provider": "pending_transmission", "queued": True, "retry": True}
        )

    def health(self) -> ProviderHealth:
        return ProviderHealth(
            ok=True,
            detail="Modo pendiente de transmisión: todavía no hay proveedor tecnológico conectado.",
        )


FakeOutcome = Literal["validate", "reject", "contingency"]


class FakeProvider:
    """Sólo para tests (nunca se importa desde código de producción):
    configurable para validar, RECHAZAR o simular contingencia. Cuenta sus
    llamadas (`emit_calls`/`retry_calls`) para que un test pueda verificar
    que `pay_order`/`retry_document` de verdad pasaron por acá."""

    def __init__(self, *, outcome: FakeOutcome = "validate", reject_reason: str = "Datos del adquirente inválidos") -> None:
        self.outcome = outcome
        self.reject_reason = reject_reason
        self.emit_calls: list[int] = []
        self.retry_calls: list[int] = []

    def _result_for(self, document: "FiscalDocument") -> EmitResult:
        if self.outcome == "reject":
            return EmitResult(
                status="rejected",
                response={"provider": "fake", "reason": self.reject_reason},
            )
        if self.outcome == "contingency":
            return EmitResult(
                status="contingency",
                response={"provider": "fake", "reason": "La DIAN no respondió dentro del tiempo esperado"},
            )
        cude = f"FAKE-CUDE-{document.id}-{document.number}"
        return EmitResult(
            status="validated",
            cude=cude,
            qr_url=f"https://fake-dian.test/qr/{cude}",
            xml_ref=f"fake://xml/{cude}.xml",
            response={"provider": "fake", "validated": True},
        )

    def emit(self, document: "FiscalDocument") -> EmitResult:
        self.emit_calls.append(document.id)
        return self._result_for(document)

    def retry(self, document: "FiscalDocument") -> EmitResult:
        self.retry_calls.append(document.id)
        return self._result_for(document)

    def health(self) -> ProviderHealth:
        return ProviderHealth(ok=self.outcome != "reject", detail=f"FakeProvider(outcome={self.outcome!r})")


_override: FiscalProvider | None = None


def set_provider_override(provider: FiscalProvider | None) -> None:
    """Sólo para tests: fuerza qué `FiscalProvider` devuelve `get_provider`
    (mismo patrón que `app.core.clock.set_clock`). `None` restaura el
    default de producción (`PendingTransmissionProvider`)."""
    global _override
    _override = provider


def get_provider(db: "Session", store: "Store") -> FiscalProvider:
    """Elige el `FiscalProvider` de la sede. Hoy sólo existe un proveedor
    real (`PendingTransmissionProvider`) porque el dueño todavía no eligió
    uno tecnológico (SPEC-NEGOCIO §8.3): `db`/`store` quedan en la firma para
    el día en que la elección sea por sede/organización, sin que
    `pay_order`/`issue_document` tengan que cambiar una línea."""
    del db, store
    if _override is not None:
        return _override
    return PendingTransmissionProvider()
