repo: Bryreg/restaurante-sistema
branch: main
path: frontend/src

## Last sync
date: 2026-09-28T00:22:11Z

### Updated in this project
- Tanda 1: POS de la tablet (pantallas 1–7), salón claro y pizarra
- Tanda 2: panel del dueño (pantallas 8–13), libro claro y noche, escritorio y celular

## Screen map
| Pantalla | Archivos del repo |
|---|---|
| POS.dc.html (lienzo) | frontend/src/index.css, frontend/src/app/PosLayout.tsx, frontend/src/app/theme.tsx |
| PosBarra.dc.html | frontend/src/app/PosLayout.tsx, frontend/src/features/shifts/ShiftStatusStrip.tsx |
| PosQuienOpera.dc.html | frontend/src/components/PinPad.tsx, frontend/src/app/PosLayout.tsx |
| PosApertura.dc.html | frontend/src/components/DenominationKeypad.tsx, frontend/src/features/shifts/EnvelopeOpeningForm.tsx |
| PosMesas.dc.html | frontend/src/features/orders/TablesPage.tsx, frontend/src/features/shifts/CashRibbon.tsx |
| PosComanda.dc.html | frontend/src/features/orders/OrderPage.tsx, frontend/src/features/orders/CatalogPanel.tsx |
| PosCobro.dc.html | frontend/src/features/payments/CheckoutPage.tsx, frontend/src/features/payments/SplitBillPanel.tsx |
| PosKds.dc.html | frontend/src/features/kitchen/KdsPage.tsx, frontend/src/index.css (.tiquete) |
| PosConteo.dc.html | frontend/src/features/inventory/AreaCountPanel.tsx |
| Panel.dc.html (lienzo) | frontend/src/index.css, frontend/src/app/AdminLayout.tsx |
| AdminRail.dc.html / AdminTop.dc.html | frontend/src/app/AdminLayout.tsx, frontend/src/components/admin/RailItem.tsx |
| AdminHoy.dc.html | frontend/src/features/reports/TodayPage.tsx, frontend/src/components/admin/NoticeRail.tsx, frontend/src/components/StatTile.tsx, frontend/src/components/admin/PageHeader.tsx |
| AdminFichaTurno.dc.html | frontend/src/features/reports/fichas/FichaTurno.tsx, frontend/src/components/admin/HeadlineFigure.tsx |
| AdminFicha.dc.html | frontend/src/features/reports/fichas/FichaPersona.tsx, frontend/src/features/reports/fichas/FichaInsumo.tsx |
| AdminInformes.dc.html | frontend/src/features/reports/InformesPage.tsx |
| AdminTabla.dc.html | frontend/src/components/admin/DenseTable.tsx, frontend/src/features/inventory/StockTab.tsx |
| AdminMovil.dc.html | frontend/src/app/AdminLayout.tsx (BarraInferior), frontend/src/features/notifications/NotificationBell.tsx |
