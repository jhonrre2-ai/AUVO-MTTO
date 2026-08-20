# Renombrador AUVO — Arneg Andina

App web de una sola página (HTML + CSS + JS) para renombrar en lote los PDF de
mantenimiento que descargas de AUVO 2Workers. **Todo el procesamiento ocurre
en el navegador**: los PDF nunca se suben a ningún servidor ni se guardan en
ninguna base de datos. Al cerrar o recargar la pestaña, todo desaparece de la
memoria — no hay nada que borrar.

Lo único que se guarda es tu **lista de tiendas** (texto de búsqueda +
abreviatura), y se guarda en `localStorage` **de tu propio navegador**, no en
internet. Puedes exportarla/importarla en JSON como respaldo.

## Formato de salida

```
ABREVIATURA - EQUIPO - DD-MM-AAAA.pdf
```

Ejemplo con tu informe de prueba:

```
EXI EJE - RM02-25 - CV CARNES EMPACADAS - 18-06-2026.pdf
```

## Archivos

- `index.html` — estructura de la página
- `style.css` — estilos
- `app.js` — lógica (lectura de PDF con pdf.js, extracción de campos, ZIP con JSZip)

No hay backend, no hay `package.json`, no hay build. Son 3 archivos estáticos.

---

## Opción recomendada: GitHub Pages (gratis, sin tarjeta, sin límites de tráfico)

1. Crea una cuenta en https://github.com si no tienes una.
2. Click en **New repository**. Nómbralo, por ejemplo, `renombrador-auvo`.
   Márcalo como **Public**. No agregues README (ya tienes uno).
3. Dentro del repo recién creado, click en **Add file → Upload files**, y
   arrastra los 3 archivos (`index.html`, `style.css`, `app.js`) y este
   `README.md`. Click en **Commit changes**.
4. Ve a **Settings → Pages** (menú lateral izquierdo).
5. En "Build and deployment", en **Source** selecciona **Deploy from a
   branch**. En **Branch** selecciona `main` y la carpeta `/ (root)`. Click
   **Save**.
6. Espera 1–2 minutos y recarga la página. GitHub te mostrará la URL pública,
   algo como:
   `https://tu-usuario.github.io/renombrador-auvo/`
7. Esa es tu app, ya en internet, gratis y para siempre mientras el repo
   exista.

Cada vez que quieras cambiar algo, subes el archivo actualizado desde
**Add file → Upload files** de nuevo y GitHub Pages se actualiza solo.

## Alternativa: Cloudflare Pages (ya la usas para tu boda)

1. En https://dash.cloudflare.com → **Workers & Pages → Create → Pages →
   Upload assets**.
2. Nombra el proyecto (ej. `renombrador-auvo`) y arrastra los 3 archivos.
3. Click **Deploy**. Te da una URL tipo `renombrador-auvo.pages.dev`.
4. Igual que GitHub Pages: 100% gratis, sin backend, sin base de datos.

Cualquiera de las dos opciones sirve — GitHub Pages es un poco más simple de
mantener si nunca has usado Cloudflare Pages para "solo archivos estáticos"
(tu wedding site usa WordPress, que es distinto a esto).

---

## Cómo se usa

1. Abre la URL publicada.
2. En el panel izquierdo, registra tus tiendas: escribe el texto que
   aparece en el PDF (ej. `EXITO EJECUTIVOS`) y la abreviatura que quieres
   usar (ej. `EXI EJE`). Click en **+ Agregar tienda**. Repite para cada
   tienda que atiendas.
3. Arrastra o selecciona todos los PDF que descargaste de AUVO.
4. La app lee cada PDF, detecta tienda / equipo / fecha, y arma el nombre
   final. Si algo no se detectó (por ejemplo, una tienda que aún no has
   registrado), la fila queda marcada como **"Revisar"** en amarillo, y
   puedes escribir manualmente el nombre correcto en la casilla — o agregar
   la tienda faltante en el panel izquierdo, la app vuelve a intentar el
   match automáticamente en los archivos ya cargados.
5. Click en **Descargar .zip renombrado**. Se descarga un único `.zip` con
   todos los PDF ya con su nombre final.

## Notas técnicas

- Extracción de texto: `pdf.js` (Mozilla), cargado desde CDN — no requiere
  instalación.
- Empaquetado ZIP: `JSZip`, también desde CDN.
- Detección de tienda: coincidencia por texto (sin tildes, sin importar
  mayúsculas) contra la lista que tú registras — nunca se "adivina" la
  abreviatura, siempre es la que tú asignaste.
- Detección de equipo: toma el texto que sigue a la etiqueta `Equipo:` hasta
  antes de `Identificador` o fin de línea.
- Detección de fecha: toma la primera fecha `DD/MM/AAAA` que aparece después
  de la etiqueta `Fecha/Hora`, y la reescribe con guiones.
- Si AUVO cambia el formato de sus PDF en el futuro y algún campo deja de
  detectarse, siempre puedes corregir el nombre a mano en la casilla antes
  de descargar — la app no bloquea la descarga por eso.
