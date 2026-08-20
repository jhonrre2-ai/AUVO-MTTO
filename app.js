pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const STORAGE_KEY = "auvo_renamer_stores_v1";

/* ---------------------------------------------------------------------- */
/* Estado                                                                  */
/* ---------------------------------------------------------------------- */
let stores = loadStores();           // [{match, abbr}]
let items = [];                      // [{id, file, status, store, equipo, fecha, finalName, rawText}]

/* ---------------------------------------------------------------------- */
/* Utilidades de texto                                                     */
/* ---------------------------------------------------------------------- */
function normalize(str) {
  return (str || "")
    .toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // quita tildes
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeFilenamePart(str) {
  return (str || "").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

/* ---------------------------------------------------------------------- */
/* Persistencia de tiendas                                                 */
/* ---------------------------------------------------------------------- */
function loadStores() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function saveStores() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stores));
}

/* ---------------------------------------------------------------------- */
/* Extracción de texto del PDF (reconstruye líneas por posición Y)         */
/* ---------------------------------------------------------------------- */
async function extractPdfText(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let fullText = "";
  let richLines = []; // [{ y, parts:[{x, str, bold}] }] — conserva info de negrilla por palabra

  const maxPages = Math.min(pdf.numPages, 2); // los datos que necesitamos siempre están en la página 1
  for (let p = 1; p <= maxPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const styles = content.styles || {};

    // Agrupar items por línea usando la coordenada Y (con tolerancia)
    const lines = [];
    content.items.forEach(item => {
      const y = Math.round(item.transform[5]);
      let line = lines.find(l => Math.abs(l.y - y) <= 2);
      if (!line) { line = { y, parts: [] }; lines.push(line); }

      const style = styles[item.fontName] || {};
      const fam = (style.fontFamily || "").toLowerCase();
      const bold = /bold|black|heavy|semibold/.test(fam) || /bold/i.test(item.fontName || "");

      line.parts.push({ x: item.transform[4], str: item.str, bold });
    });
    lines.sort((a, b) => b.y - a.y);
    lines.forEach(l => l.parts.sort((a, b) => a.x - b.x));
    lines.forEach(l => richLines.push(l));

    const pageText = lines.map(l => l.parts.map(p => p.str).join(" ").replace(/\s+/g, " ").trim()).join("\n");
    fullText += pageText + "\n";
  }
  return { fullText, richLines };
}

/* ---------------------------------------------------------------------- */
/* Parsing de campos                                                       */
/* ---------------------------------------------------------------------- */
function findStore(text) {
  const normText = normalize(text);
  const candidates = stores
    .filter(s => s.match && s.abbr)
    .slice()
    .sort((a, b) => normalize(b.match).length - normalize(a.match).length); // más largo primero

  for (const s of candidates) {
    if (normText.includes(normalize(s.match))) {
      return s.abbr;
    }
  }
  return null;
}

// Método principal: el nombre del equipo siempre viene en negrilla, el
// "Identificador ..." que le sigue no. Cortamos justo donde deja de ser negrilla.
function findEquipoBold(richLines) {
  for (const line of richLines) {
    const labelIdx = line.parts.findIndex(p => /Equipo/i.test(p.str));
    if (labelIdx === -1) continue;

    let collected = [];
    let started = false;
    for (let i = labelIdx + 1; i < line.parts.length; i++) {
      const part = line.parts[i];
      const isJustColon = /^:?\s*$/.test(part.str);
      if (isJustColon && !started) continue; // salta el ":" del label

      if (part.bold) {
        started = true;
        collected.push(part.str);
      } else if (started) {
        break; // dejó de ser negrilla → aquí empieza "Identificador ..."
      }
    }
    const text = collected.join(" ").replace(/\s+/g, " ").trim().replace(/[-\s]+$/, "");
    if (text) return text;
  }
  return null;
}

// Respaldo por si el PDF no trae info de negrilla utilizable.
function findEquipo(text) {
  const idx = text.search(/Equipo\s*:/i);
  if (idx === -1) return null;
  const sub = text.slice(idx);
  // Algunos PDF parten "Identificador" en pedazos por ligaduras de fuente
  // (ej. "Identi fi cador"), así que cortamos apenas aparezca el prefijo "Identi".
  const m = sub.match(/Equipo\s*:\s*([^\n]*?)(?:\s*Identi|\n|$)/i);
  if (m && m[1].trim()) return m[1].trim().replace(/[-\s]+$/, "");
  return null;
}

function findFecha(text) {
  const idx = text.search(/Fecha\s*\/?\s*y?\s*Hora/i);
  const searchZone = idx !== -1 ? text.slice(idx) : text;
  const m = searchZone.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function buildFinalName(storeAbbr, equipo, fecha) {
  const parts = [storeAbbr, equipo, fecha].filter(Boolean).map(sanitizeFilenamePart);
  if (parts.length === 0) return "";
  return parts.join(" - ") + ".pdf";
}

/* ---------------------------------------------------------------------- */
/* Render: lista de tiendas                                                */
/* ---------------------------------------------------------------------- */
const storeListEl = document.getElementById("storeList");
const storeCountEl = document.getElementById("storeCount");

function renderStores() {
  storeCountEl.textContent = stores.length;
  storeListEl.innerHTML = "";

  if (stores.length === 0) {
    const empty = document.createElement("li");
    empty.className = "store-list__empty";
    empty.textContent = "Aún no hay tiendas registradas.";
    storeListEl.appendChild(empty);
    return;
  }

  stores.forEach((s, i) => {
    const li = document.createElement("li");
    li.className = "store-item";
    li.innerHTML = `
      <div class="store-item__text">
        <span class="store-item__match">${escapeHtml(s.match)}</span>
        <span class="store-item__abbr">→ ${escapeHtml(s.abbr)}</span>
      </div>
      <button class="store-item__del" title="Eliminar" data-index="${i}">✕</button>
    `;
    storeListEl.appendChild(li);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

storeListEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".store-item__del");
  if (!btn) return;
  const idx = Number(btn.dataset.index);
  stores.splice(idx, 1);
  saveStores();
  renderStores();
  reprocessAllStoreMatches();
});

document.getElementById("storeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const matchEl = document.getElementById("storeMatch");
  const abbrEl = document.getElementById("storeAbbr");
  const match = matchEl.value.trim();
  const abbr = abbrEl.value.trim();
  if (!match || !abbr) return;
  stores.push({ match, abbr });
  saveStores();
  matchEl.value = ""; abbrEl.value = "";
  matchEl.focus();
  renderStores();
  reprocessAllStoreMatches();
});

document.getElementById("exportStores").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(stores, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "tiendas_auvo.json"; a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("importStoresInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      stores = parsed.filter(s => s && s.match && s.abbr);
      saveStores();
      renderStores();
      reprocessAllStoreMatches();
    }
  } catch (err) {
    alert("No se pudo leer el archivo de tiendas. Debe ser el .json exportado desde aquí.");
  }
  e.target.value = "";
});

/* Si el usuario agrega/edita/borra una tienda, volvemos a intentar el match
   de tienda en los archivos que ya estaban pendientes por falta de coincidencia */
function reprocessAllStoreMatches() {
  items.forEach(it => {
    if (it.rawText) {
      const store = findStore(it.rawText);
      it.store = store;
      it.finalName = buildFinalName(store, it.equipo, it.fecha);
      renderResultRow(it);
    }
  });
  updateToolbar();
}

/* ---------------------------------------------------------------------- */
/* Dropzone / selección de archivos                                        */
/* ---------------------------------------------------------------------- */
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const resultsEl = document.getElementById("results");
const toolbar = document.getElementById("toolbar");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });

["dragover", "dragenter"].forEach(evt => {
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("is-dragover"); });
});
["dragleave", "drop"].forEach(evt => {
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("is-dragover"); });
});
dropzone.addEventListener("drop", (e) => {
  const files = [...e.dataTransfer.files].filter(f => f.type === "application/pdf");
  handleNewFiles(files);
});
fileInput.addEventListener("change", (e) => {
  handleNewFiles([...e.target.files]);
  fileInput.value = "";
});

function handleNewFiles(files) {
  if (!files.length) return;
  toolbar.hidden = false;
  files.forEach(file => {
    const id = crypto.randomUUID();
    const item = { id, file, status: "loading", store: null, equipo: null, fecha: null, finalName: "", rawText: "" };
    items.push(item);
    renderResultRow(item, true);
    processFile(item);
  });
  updateToolbar();
}

/* ---------------------------------------------------------------------- */
/* Procesamiento individual                                                */
/* ---------------------------------------------------------------------- */
async function processFile(item) {
  try {
    const { fullText, richLines } = await extractPdfText(item.file);
    item.rawText = fullText;
    item.store = findStore(fullText);
    item.equipo = findEquipoBold(richLines) || findEquipo(fullText);
    item.fecha = findFecha(fullText);
    item.finalName = buildFinalName(item.store, item.equipo, item.fecha);
    item.status = (item.store && item.equipo && item.fecha) ? "ok" : "warn";
  } catch (err) {
    console.error(err);
    item.status = "error";
    item.finalName = item.file.name;
  }
  renderResultRow(item);
  updateToolbar();
}

/* ---------------------------------------------------------------------- */
/* Render de filas de resultado                                            */
/* ---------------------------------------------------------------------- */
const rowTemplate = document.getElementById("resultRowTemplate");
const rowElements = new Map();

function renderResultRow(item, isNew) {
  let row = rowElements.get(item.id);
  if (!row) {
    row = rowTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.id = item.id;
    rowElements.set(item.id, row);
    resultsEl.prepend(row);

    row.querySelector(".result-row__input").addEventListener("input", (e) => {
      item.finalName = e.target.value;
    });
  }

  row.dataset.state = item.status;
  row.querySelector(".result-row__filename--original").textContent = item.file.name;

  const chipStore = row.querySelector(".chip--store");
  const chipEquipo = row.querySelector(".chip--equipo");
  const chipFecha = row.querySelector(".chip--fecha");

  setChip(chipStore, item.status === "loading" ? "…" : (item.store || "tienda no detectada"), !!item.store);
  setChip(chipEquipo, item.status === "loading" ? "…" : (item.equipo || "equipo no detectado"), !!item.equipo);
  setChip(chipFecha, item.status === "loading" ? "…" : (item.fecha || "fecha no detectada"), !!item.fecha);

  const input = row.querySelector(".result-row__input");
  if (document.activeElement !== input) {
    input.value = item.finalName || (item.status === "loading" ? "" : item.file.name);
  }

  const statusText = row.querySelector(".status-text");
  statusText.textContent =
    item.status === "loading" ? "Leyendo…" :
    item.status === "ok" ? "Listo" :
    item.status === "warn" ? "Revisar" :
    "Error al leer";
}

function setChip(el, text, found) {
  el.textContent = text;
  el.classList.toggle("chip--found", found);
  el.classList.toggle("chip--missing", !found);
}

/* ---------------------------------------------------------------------- */
/* Toolbar / stats                                                         */
/* ---------------------------------------------------------------------- */
const statTotal = document.getElementById("statTotal");
const statOk = document.getElementById("statOk");
const statWarn = document.getElementById("statWarn");
const downloadZipBtn = document.getElementById("downloadZipBtn");
const fileCountFoot = document.getElementById("fileCountFoot");

function updateToolbar() {
  const total = items.length;
  const ok = items.filter(i => i.status === "ok").length;
  const warn = items.filter(i => i.status === "warn" || i.status === "error").length;
  statTotal.textContent = total;
  statOk.textContent = `${ok} listos`;
  statWarn.textContent = `${warn} con alerta`;
  downloadZipBtn.disabled = total === 0 || items.some(i => i.status === "loading");
  fileCountFoot.textContent = `${total} archivo(s) en memoria`;
}

document.getElementById("clearBtn").addEventListener("click", () => {
  items = [];
  rowElements.clear();
  resultsEl.innerHTML = "";
  toolbar.hidden = true;
  updateToolbar();
});

/* ---------------------------------------------------------------------- */
/* Descarga en ZIP                                                         */
/* ---------------------------------------------------------------------- */
downloadZipBtn.addEventListener("click", async () => {
  if (!items.length) return;
  downloadZipBtn.disabled = true;
  downloadZipBtn.textContent = "Generando .zip…";

  const zip = new JSZip();
  const usedNames = new Set();

  for (const item of items) {
    const row = rowElements.get(item.id);
    const nameFromInput = row.querySelector(".result-row__input").value.trim();
    let finalName = nameFromInput || item.finalName || item.file.name;
    if (!finalName.toLowerCase().endsWith(".pdf")) finalName += ".pdf";

    // evitar sobreescritura si dos resultan con el mismo nombre
    let unique = finalName;
    let n = 2;
    while (usedNames.has(unique)) {
      unique = finalName.replace(/\.pdf$/i, ` (${n}).pdf`);
      n++;
    }
    usedNames.add(unique);

    const buf = await item.file.arrayBuffer();
    zip.file(unique, buf);
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `informes_renombrados_${new Date().toISOString().slice(0,10)}.zip`;
  a.click();
  URL.revokeObjectURL(url);

  downloadZipBtn.textContent = "Descargar .zip renombrado";
  downloadZipBtn.disabled = false;
});

/* ---------------------------------------------------------------------- */
/* Init                                                                     */
/* ---------------------------------------------------------------------- */
renderStores();
