# MuraTweaks

Optimizador de Windows open source. 331 ajustes en 13 categorias, con backup y
reversion de cada cambio. Sin cuentas, sin telemetria y sin llamadas de red.

## Que incluye

- **Optimizar**: rendimiento FPS, latencia e input lag, GPU, red y WiFi, CPU y
  memoria, energia, Windows, personalizacion, segundo plano, privacidad,
  almacenamiento, perifericos, BIOS y drivers, y prioridad de juegos.
- **Backups**: antes de aplicar un ajuste se guardan los valores de registro
  anteriores. Se pueden restaurar desde la app, deshacer todos los cambios o
  crear un punto de restauracion de Windows.
- Cada tweak indica su nivel de riesgo (seguro / moderado / riesgoso) y muestra
  un aviso antes de aplicar los que pueden afectar estabilidad o seguridad.

## Que NO incluye

Respecto de la app que sirvio de referencia, esta version elimina:

- Funciones pagas, licencias, Premium y generador de keys.
- Telemetria, reporte de errores y estadisticas de uso.
- CeitoGames, descargas, descuentos, comunidad, ranking, cuentas y perfiles.
- Cualquier llamada a `api.ceitotweaks.com` o a servidores externos.

El codigo de red no existe en este proyecto: no hay updater, ni analitica, ni
login.

## Requisitos

- Windows 10 u 11.
- Node.js 22.12 o superior para correr desde el codigo.
- Permisos de administrador para la mayoria de los ajustes (HKLM, servicios,
  `bcdedit`, `powercfg`, PowerShell del sistema).

## Uso

```bash
npm install
npm start
```

Si tu politica de npm bloquea los scripts de instalacion y Electron queda sin
binario, ejecuta `node node_modules/electron/install.js` y volve a `npm start`.

Si la app arranca sin permisos, aparece una banda arriba con el boton
**Reiniciar como administrador**.

Tests del motor y del catalogo (incluyen escrituras reales en una clave HKCU
temporal):

```bash
npm test
```

Instalador `.exe` (NSIS, x64):

```bash
npm run dist
```

Queda en `release/MuraTweaks-Setup-1.0.0.exe`. Cerra la app antes de compilar:
Windows bloquea el `.exe` de `release/win-unpacked` si esta en ejecucion. No esta
firmado: Windows puede mostrar SmartScreen al ejecutarlo.

## Como funcionan los backups

Antes de tocar el registro, el motor lee cada valor que el ajuste va a cambiar y
lo guarda en `%APPDATA%\MuraTweaks\backups\`. Al revertir:

1. Se restauran esos valores exactos (incluidos los que no existian antes).
2. Se ejecutan los comandos de reversion del ajuste que no son de registro
   (servicios, `netsh`, `bcdedit`, etc.).

Los ajustes que solo corren scripts se pueden deshacer igual mientras exista el
backup; si un script falla a mitad de camino, la app restaura los valores de
registro ya aplicados y avisa que parte no se pudo revertir.

## Estructura

```
main.js              proceso principal de Electron e IPC
preload.js           API puente (contextBridge)
engine/catalog.js    carga y valida data/catalog.json
engine/registry.js   lectura, escritura y snapshots de registro
engine/tweaks.js     aplicar / revertir / deshacer todo
engine/powerplan.js  plan de energia "Mura Rendimiento"
engine/backups.js    backups y estado aplicado
renderer/            interfaz (HTML/CSS/JS, sin dependencias)
data/catalog.json    catalogo de ajustes
tools/               extractor y generador del catalogo
test/                pruebas del motor y del catalogo
```

El catalogo se genero observando la aplicacion original instalada localmente
(ver `tools/record-tweaks.js` y `tools/build-catalog.js`). No se redistribuyen
binarios, instaladores ni recursos de la app original.

## Licencia

MIT. Ver [LICENSE](LICENSE).
