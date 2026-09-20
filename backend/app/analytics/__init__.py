"""Qué conviene vender (SPEC-NEGOCIO §5.4 y §10).

Dominio de la fase 3 (T4 — ingeniería de menú, varianza por plato, reposición, «sostenido»).

El paquete lo creó el orquestador humano en el **paso 0** del pedido, antes de
lanzar el equipo: `app.main.DOMAINS` y `app.core.models_registry.MODEL_MODULES`
ya nombran este dominio, y `find_spec_safe` necesita que el paquete exista para
resolver `None` limpio mientras sus módulos todavía no están escritos (en vez de
lanzar `ModuleNotFoundError`, la lección de 1b-1).

Ver `features/fase-3-dinero-control/spec.md § 2`.
"""
