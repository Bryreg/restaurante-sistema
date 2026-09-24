"""Fotos de soporte: comprobantes, sobres, cierres, recepciones y mermas.

Las pantallas mandan la foto como *data URL* y cada dominio guardaba ese
texto tal cual en una columna `String(500)`. Una foto de tablet son cientos
de kilobytes: en Postgres (producción) el `INSERT` fallaba por largo, y una
consignación con comprobante la rechazaba el esquema. SQLite no hace cumplir
el largo, y los tests usaban `"c.jpg"`: nada lo veía.

Ahora la foto vive en su propia tabla y las columnas de siempre guardan su
dirección (`/api/v1/photos/<id>`), que sí cabe. Los dominios no importan este
paquete salvo por `app.photos.hooks`.
"""
