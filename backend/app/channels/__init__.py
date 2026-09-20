"""Dominio `channels` — el DINERO de los canales nuevos (pedido 2c).

Paquete creado **antes** de que `"channels"` aparezca en `app.main.DOMAINS`
o en `app.core.models_registry.MODEL_MODULES`. Es una regla dura del repo
(`docs/ESTADO.md`, defecto encontrado en 1b-1): `find_spec("app.channels.router")`
importa primero el paquete padre para resolver su `__path__`; sin carpeta
levanta `ModuleNotFoundError` en vez de devolver `None` y tumba el arranque
de TODA la API. Con `__init__.py` presente, `app.core.modules.find_spec_safe`
resuelve `None` limpio si el archivo puntual todavía no existe.
"""
