"""El service worker y el manifiesto se sirven desde la raíz del sitio con
su tipo y sin caché (0031). El iPhone mira el manifiesto para «Agregar a
inicio», y un service worker servido como `index.html` (el fallback SPA)
nunca se registra."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import _mount_frontend


def test_sw_and_manifest_are_served_at_the_root_with_their_type(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<!doctype html><title>x</title>", encoding="utf-8")
    (tmp_path / "sw.js").write_text("self.addEventListener('push', () => {});", encoding="utf-8")
    (tmp_path / "manifest.webmanifest").write_text('{"name": "Restaurante"}', encoding="utf-8")
    app = FastAPI()
    _mount_frontend(app, tmp_path)
    client = TestClient(app)

    sw = client.get("/sw.js")
    assert sw.status_code == 200
    assert sw.headers["content-type"].startswith("text/javascript")
    assert sw.headers["cache-control"] == "no-cache"
    assert sw.headers["service-worker-allowed"] == "/"
    assert "push" in sw.text

    manifest = client.get("/manifest.webmanifest")
    assert manifest.headers["content-type"].startswith("application/manifest+json")
    assert manifest.json()["name"] == "Restaurante"

    # Una ruta del admin sigue cayendo en la aplicación.
    assert "<title>x</title>" in client.get("/admin/hoy").text


def test_the_real_build_ships_the_service_worker_and_the_manifest() -> None:
    """Los archivos fuente viven en `frontend/public/` (Vite los copia tal
    cual a la raíz de `dist/`): si alguien los mueve, el build deja de
    llevarlos y nadie lo nota hasta que un celular no recibe nada."""
    public = Path(__file__).resolve().parents[3] / "frontend" / "public"
    assert (public / "sw.js").is_file()
    manifest = (public / "manifest.webmanifest").read_text(encoding="utf-8")
    assert '"start_url": "/admin/hoy"' in manifest and '"display": "standalone"' in manifest
    for icon in ("icon-192.png", "icon-512.png", "apple-touch-icon.png"):
        assert (public / "icons" / icon).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
