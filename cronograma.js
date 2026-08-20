/* ==========================================================================
   CRONOGRAMA — cruce de informes AUVO contra el Excel maestro de mantenimiento
   ==========================================================================
   Todo corre en el navegador. El .xlsm se abre como ZIP (JSZip), se localizan
   las celdas exactas (equipo × fecha real de ejecución) y se edita SOLO el
   texto de esas celdas puntuales dentro del XML interno — sin tocar macros,
   fórmulas, tablas ni las reglas de formato condicional que ya pintan
   automáticamente P/E/X/R/C según el texto de la celda.
   ========================================================================== */

/* ---------------------------------------------------------------------- */
/* Estado                                                                  */
/* ---------------------------------------------------------------------- */
let cronoXlsm = null;        // { zip, sheetPath, sheetXml, sharedStrings, dateColMap, rowIndex, fileName }
let cronoItems = [];         // [{id, file, status, equipoCode, equipoTextExcel, fechaHoraTexto, fechaEfectiva, celda, rowNumber}]

/* ---------------------------------------------------------------------- */
/* Utilidades de fecha                                                     */
/* ---------------------------------------------------------------------- */
function excelSerialToDate(serial) {
  // Excel (modo 1900): día 0 = 30-dic-1899. Usamos UTC para evitar líos de huso horario.
  const ms = Math.round((Number(serial) - 25569) * 86400 * 1000);
  return new Date(ms);
}

function dateToYMD(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function ddmmyyyyToDate(ddmmyyyy) {
  // "18-06-2026" -> Date UTC
  const [d, m, y] = ddmmyyyy.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function shiftDaysUTC(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/* ---------------------------------------------------------------------- */
/* Extracción de PDF: equipo + fecha/hora (reutiliza la misma lógica de
   negrilla del renombrador, pero aquí también necesitamos la HORA)       */
/* ---------------------------------------------------------------------- */
async function cronoExtractPdf(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let fullText = "";
  let richLines = [];

  const maxPages = Math.min(pdf.numPages, 2);
  for (let p = 1; p <= maxPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const styles = content.styles || {};

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

  const equipo = cronoFindEquipoBold(richLines) || cronoFindEquipo(fullText);
  const fechaHora = cronoFindFechaHora(fullText);
  const activityStatus = cronoActivityStatus(fullText);
  return { equipo, fechaHora, activityStatus };
}

// "ejecutado" si aparece al menos un "Si" en la zona de actividades,
// "no_ejecutado" si solo aparecen "No", null si no se pudo determinar.
function cronoActivityStatus(text) {
  const idx = text.search(/ACTIVIDADES\s+SEG[UÚ]N\s+FRECUENCIAS/i);
  if (idx === -1) return null;
  const zone = text.slice(idx, idx + 1000);
  const hasSi = /\bSi\b/i.test(zone);
  const hasNo = /\bNo\b/i.test(zone);
  if (hasSi) return "ejecutado";
  if (hasNo) return "no_ejecutado";
  return null;
}

function cronoFindEquipoBold(richLines) {
  for (const line of richLines) {
    const labelIdx = line.parts.findIndex(p => /Equipo/i.test(p.str));
    if (labelIdx === -1) continue;
    let collected = [];
    let started = false;
    for (let i = labelIdx + 1; i < line.parts.length; i++) {
      const part = line.parts[i];
      const isJustColon = /^:?\s*$/.test(part.str);
      if (isJustColon && !started) continue;
      if (part.bold) { started = true; collected.push(part.str); }
      else if (started) break;
    }
    const text = collected.join(" ").replace(/\s+/g, " ").trim().replace(/[-\s]+$/, "");
    if (text) return text;
  }
  return null;
}

function cronoFindEquipo(text) {
  const idx = text.search(/Equipo\s*:/i);
  if (idx === -1) return null;
  const sub = text.slice(idx);
  const m = sub.match(/Equipo\s*:\s*([^\n]*?)(?:\s*Identi|\n|$)/i);
  if (m && m[1].trim()) return m[1].trim().replace(/[-\s]+$/, "");
  return null;
}

// Devuelve { ddmmyyyy: "18-06-2026", hh: 11, mm: 33 } o null
function cronoFindFechaHora(text) {
  const idx = text.search(/Fecha\s*\/?\s*y?\s*Hora/i);
  const zone = idx !== -1 ? text.slice(idx) : text;
  const m = zone.match(/(\d{2})\/(\d{2})\/(\d{4})[^\d]{0,6}(\d{2}):(\d{2})/);
  if (!m) return null;
  return {
    ddmmyyyy: `${m[1]}-${m[2]}-${m[3]}`,
    hh: parseInt(m[4], 10),
    mm: parseInt(m[5], 10),
  };
}

/* Fecha efectiva: si la ejecución fue antes de las 6:00 a.m., pertenece a la
   jornada del día anterior. */
function cronoFechaEfectiva(fechaHora) {
  const base = ddmmyyyyToDate(fechaHora.ddmmyyyy);
  if (fechaHora.hh < 6) return shiftDaysUTC(base, -1);
  return base;
}

function cronoNormalize(str) {
  return (str || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

function cronoExtractCode(equipoText) {
  if (!equipoText) return null;
  const parts = equipoText.split(" - ");
  return cronoNormalize(parts[0]);
}

// Para informes de Rack / Gas Cooler el PDF no trae un código individual —
// se identifican por similitud contra el nombre del equipo compartido.
function cronoDetectCategoria(equipoText) {
  const norm = cronoNormalize(equipoText);
  if (norm.includes("RACK")) return "RACK DE COMPRESORES";
  if (norm.includes("GASCOOLER") || norm.includes("GAS COOLER")) return "GAS COOLER";
  return null;
}

/* ---------------------------------------------------------------------- */
/* Parsing del .xlsm (XML crudo, sin reconstruir el archivo)               */
/* ---------------------------------------------------------------------- */
async function cronoParseXlsm(file) {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  // 1) Ubicar la hoja principal a través de workbook.xml / rels
  const workbookXml = await zip.file("xl/workbook.xml").async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");

  const sheetMatches = [...workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"[^>]*\/>/g)];
  if (!sheetMatches.length) throw new Error("No se encontraron hojas en el workbook.");

  // Preferimos la hoja cuyo nombre parezca un rango de meses (ej. "DIC25 - DIC26");
  // si no encaja el patrón, usamos la primera hoja del archivo.
  let chosen = sheetMatches.find(m => /\d{2}\s*-\s*[A-ZÑ]{3}\d{2}/i.test(m[1])) || sheetMatches[0];
  const rId = chosen[2];

  const relMatch = relsXml.match(new RegExp(`<Relationship[^>]*Id="${rId}"[^>]*Target="([^"]+)"`));
  if (!relMatch) throw new Error("No se pudo resolver la ruta de la hoja principal.");
  const sheetPath = "xl/" + relMatch[1].replace(/^\/?xl\//, "");

  const sheetFile = zip.file(sheetPath);
  if (!sheetFile) throw new Error(`No se encontró ${sheetPath} dentro del archivo.`);
  const sheetXml = await sheetFile.async("string");

  // 2) Shared strings (tabla de textos reutilizados)
  let sharedStrings = [];
  const ssFile = zip.file("xl/sharedStrings.xml");
  if (ssFile) {
    const ssXml = await ssFile.async("string");
    const siBlocks = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)];
    sharedStrings = siBlocks.map(m => {
      const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]);
      return decodeXmlEntities(texts.join(""));
    });
  }

  return { zip, sheetPath, sheetXml, sharedStrings, fileName: file.name };
}

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function cronoExtractRow(sheetXml, rowNumber) {
  const re = new RegExp(`<row r="${rowNumber}"[^>]*>([\\s\\S]*?)<\\/row>`);
  const m = sheetXml.match(re);
  return m ? m[1] : null;
}

function cronoExtractCells(rowXml) {
  const cells = [];
  const re = /<c r="([A-Z]+)(\d+)"([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = re.exec(rowXml))) {
    cells.push({
      col: m[1],
      row: m[2],
      attrs: m[3] || "",
      inner: m[5] || "",
    });
  }
  return cells;
}

function cronoCellText(cell, sharedStrings) {
  const tMatch = cell.attrs.match(/\st="([^"]+)"/);
  const type = tMatch ? tMatch[1] : "n";
  const vMatch = cell.inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
  const raw = vMatch ? vMatch[1] : "";

  if (type === "s") {
    const idx = parseInt(raw, 10);
    return sharedStrings[idx] || "";
  }
  if (type === "str" || type === "inlineStr") {
    const tMatch2 = cell.inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
    return decodeXmlEntities(tMatch2 ? tMatch2[1] : raw);
  }
  return raw; // numérico u otro
}

/* Construye: mapa fecha->columna (a partir de la fila 6) e índice de filas
   de equipo (columna B y C de cada fila con datos). */
function cronoBuildIndexes(sheetXml, sharedStrings) {
  const dateRowXml = cronoExtractRow(sheetXml, 6);
  const dateCells = dateRowXml ? cronoExtractCells(dateRowXml) : [];
  const dateColMap = {}; // 'YYYY-MM-DD' -> 'COLLETTER'
  dateCells.forEach(cell => {
    const tMatch = cell.attrs.match(/\st="([^"]+)"/);
    const type = tMatch ? tMatch[1] : "n";
    if (type !== "n" && type !== undefined) return; // solo celdas numéricas (serial de fecha)
    const vMatch = cell.inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
    if (!vMatch) return;
    const serial = parseFloat(vMatch[1]);
    if (!serial || isNaN(serial)) return;
    const d = excelSerialToDate(serial);
    dateColMap[dateToYMD(d)] = cell.col;
  });

  // Todas las filas presentes en la hoja
  const rowNumbers = [...sheetXml.matchAll(/<row r="(\d+)"/g)].map(m => parseInt(m[1], 10));
  const maxRow = Math.max(...rowNumbers);

  const rowIndex = [];
  for (let r = 9; r <= maxRow; r++) {
    const rowXml = cronoExtractRow(sheetXml, r);
    if (!rowXml) continue;
    const cells = cronoExtractCells(rowXml);
    const cellB = cells.find(c => c.col === "B");
    const cellC = cells.find(c => c.col === "C");
    const cellI = cells.find(c => c.col === "I");
    const textBRaw = cellB ? cronoCellText(cellB, sharedStrings) : "";
    const textCRaw = cellC ? cronoCellText(cellC, sharedStrings) : "";
    const textIRaw = cellI ? cronoCellText(cellI, sharedStrings) : "";
    if (!textBRaw && !textCRaw) continue;
    rowIndex.push({
      row: r,
      textB: cronoNormalize(textBRaw),
      textC: cronoNormalize(textCRaw),
      textI: cronoNormalize(textIRaw),
      textBDisplay: (textBRaw || "").replace(/\s+/g, " ").trim(),
    });
  }

  return { dateColMap, rowIndex };
}

function cronoFindEquipoRow(rowIndex, codeUpper) {
  for (const row of rowIndex) {
    if (row.textB === codeUpper || row.textB.startsWith(codeUpper + " ")) return row;
  }
  for (const row of rowIndex) {
    if (row.textC === codeUpper || row.textC.startsWith(codeUpper + " ")) return row;
  }
  return null;
}

// Busca, dentro del mismo año-mes, la celda que ya tiene "P" para esa fila.
// Devuelve { col, ymd } o null si no había nada programado ese mes.
function cronoFindScheduledPColumn(sheetXml, sharedStrings, dateColMap, rowNumber, year, month) {
  const rowXml = cronoExtractRow(sheetXml, rowNumber);
  if (!rowXml) return null;
  const cells = cronoExtractCells(rowXml);
  const cellByCol = {};
  cells.forEach(c => { cellByCol[c.col] = c; });

  for (const [ymd, col] of Object.entries(dateColMap)) {
    const [y, m] = ymd.split("-").map(Number);
    if (y !== year || m !== month) continue;
    const cell = cellByCol[col];
    if (!cell) continue;
    const text = cronoCellText(cell, sharedStrings).trim().toUpperCase();
    if (text === "P") return { col, ymd };
  }
  return null;
}

/* ---------------------------------------------------------------------- */
/* Escritura quirúrgica de una celda (preserva estilo, no toca lo demás)   */
/* ---------------------------------------------------------------------- */
function cronoWriteCell(sheetXml, cellRef, value) {
  const re = new RegExp(`<c r="${cellRef}"([^>]*?)(\\/>|>[\\s\\S]*?<\\/c>)`);
  const m = sheetXml.match(re);
  if (!m) return { xml: sheetXml, found: false };

  const attrs = m[1];
  const sMatch = attrs.match(/\ss="(\d+)"/);
  const styleAttr = sMatch ? ` s="${sMatch[1]}"` : "";
  const newCell = `<c r="${cellRef}"${styleAttr} t="str"><v>${value}</v></c>`;
  const newXml = sheetXml.slice(0, m.index) + newCell + sheetXml.slice(m.index + m[0].length);
  return { xml: newXml, found: true };
}

/* ---------------------------------------------------------------------- */
/* UI: subir el Excel                                                      */
/* ---------------------------------------------------------------------- */
const xlsmDropzone = document.getElementById("xlsmDropzone");
const xlsmInput = document.getElementById("xlsmInput");
const xlsmFileLabel = document.getElementById("xlsmFileLabel");
const xlsmStatus = document.getElementById("xlsmStatus");
const applyCronoBtn = document.getElementById("applyCronoBtn");
const cronoApplyHint = document.getElementById("cronoApplyHint");

xlsmDropzone.addEventListener("click", () => xlsmInput.click());
xlsmDropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") xlsmInput.click(); });
["dragover", "dragenter"].forEach(evt => xlsmDropzone.addEventListener(evt, (e) => { e.preventDefault(); xlsmDropzone.classList.add("is-dragover"); }));
["dragleave", "drop"].forEach(evt => xlsmDropzone.addEventListener(evt, (e) => { e.preventDefault(); xlsmDropzone.classList.remove("is-dragover"); }));
xlsmDropzone.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) handleXlsmFile(f); });
xlsmInput.addEventListener("change", (e) => { const f = e.target.files[0]; if (f) handleXlsmFile(f); e.target.value = ""; });

async function handleXlsmFile(file) {
  xlsmFileLabel.textContent = file.name;
  xlsmStatus.hidden = false;
  xlsmStatus.className = "xlsm-status";
  xlsmStatus.textContent = "Leyendo estructura del Excel…";

  try {
    const parsed = await cronoParseXlsm(file);
    const { dateColMap, rowIndex } = cronoBuildIndexes(parsed.sheetXml, parsed.sharedStrings);
    cronoXlsm = { ...parsed, dateColMap, rowIndex };

    xlsmStatus.className = "xlsm-status is-ok";
    xlsmStatus.textContent = `Listo · ${rowIndex.length} filas de equipos detectadas · ${Object.keys(dateColMap).length} columnas de fecha`;

    cronoReprocessAll();
  } catch (err) {
    console.error(err);
    xlsmStatus.className = "xlsm-status is-error";
    xlsmStatus.textContent = "No se pudo leer el archivo. Verifica que sea el .xlsm original sin modificar.";
    cronoXlsm = null;
  }
  updateCronoToolbar();
}

/* ---------------------------------------------------------------------- */
/* UI: subir PDFs                                                          */
/* ---------------------------------------------------------------------- */
const cronoDropzone = document.getElementById("cronoDropzone");
const cronoFileInput = document.getElementById("cronoFileInput");
const cronoResultsEl = document.getElementById("cronoResults");
const cronoToolbar = document.getElementById("cronoToolbar");

cronoDropzone.addEventListener("click", () => cronoFileInput.click());
cronoDropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") cronoFileInput.click(); });
["dragover", "dragenter"].forEach(evt => cronoDropzone.addEventListener(evt, (e) => { e.preventDefault(); cronoDropzone.classList.add("is-dragover"); }));
["dragleave", "drop"].forEach(evt => cronoDropzone.addEventListener(evt, (e) => { e.preventDefault(); cronoDropzone.classList.remove("is-dragover"); }));
cronoDropzone.addEventListener("drop", (e) => {
  const files = [...e.dataTransfer.files].filter(f => f.type === "application/pdf");
  cronoHandleFiles(files);
});
cronoFileInput.addEventListener("change", (e) => { cronoHandleFiles([...e.target.files]); e.target.value = ""; });

function cronoHandleFiles(files) {
  if (!files.length) return;
  cronoToolbar.hidden = false;
  files.forEach(file => {
    const id = crypto.randomUUID();
    const item = { id, file, status: "loading" };
    cronoItems.push(item);
    cronoRenderRow(item);
    cronoProcessFile(item);
  });
}

async function cronoProcessFile(item) {
  try {
    const { equipo, fechaHora, activityStatus } = await cronoExtractPdf(item.file);
    item.equipoTextPdf = equipo;
    item.fechaHora = fechaHora;
    item.activityStatus = activityStatus;

    if (!equipo || !fechaHora) {
      item.status = "error";
      cronoRenderRow(item);
      updateCronoToolbar();
      return;
    }

    item.fechaEfectiva = cronoFechaEfectiva(fechaHora);
    cronoResolveMatch(item);
  } catch (err) {
    console.error(err);
    item.status = "error";
  }
  cronoRenderRow(item);
  updateCronoToolbar();
}

function cronoResolveMatch(item) {
  item.writes = [];
  item.predictivoOptions = null;

  if (!cronoXlsm) {
    item.status = "warn";
    item.matchInfo = "Sube primero el Excel";
    return;
  }

  const categoria = cronoDetectCategoria(item.equipoTextPdf);
  if (categoria) {
    cronoResolveCategoriaMatch(item, categoria);
    return;
  }

  // --- Equipo individual con código propio (neveras, autocontenidas, etc.) ---
  const code = cronoExtractCode(item.equipoTextPdf);
  const row = cronoFindEquipoRow(cronoXlsm.rowIndex, code);
  if (!row) {
    item.status = "warn";
    item.matchInfo = "Equipo no encontrado en el Excel";
    return;
  }
  item.rowNumber = row.row;

  if (item.activityStatus === "ejecutado") {
    const ymd = dateToYMD(item.fechaEfectiva);
    const col = cronoXlsm.dateColMap[ymd];
    if (!col) {
      item.status = "warn";
      item.matchInfo = "Fecha fuera del rango del Excel";
      return;
    }
    item.writes.push({ celda: `${col}${row.row}`, markValue: "E" });
    item.status = "ok";
    item.matchInfo = `Fila ${row.row} · ejecutado`;
    return;
  }

  if (item.activityStatus === "no_ejecutado") {
    const year = item.fechaEfectiva.getUTCFullYear();
    const month = item.fechaEfectiva.getUTCMonth() + 1;
    const found = cronoFindScheduledPColumn(cronoXlsm.sheetXml, cronoXlsm.sharedStrings, cronoXlsm.dateColMap, row.row, year, month);
    if (!found) {
      item.status = "warn";
      item.matchInfo = "No había P programada ese mes";
      return;
    }
    item.writes.push({ celda: `${found.col}${row.row}`, markValue: "X" });
    item.status = "ok";
    item.matchInfo = `Fila ${row.row} · no ejecutado`;
    return;
  }

  item.status = "warn";
  item.matchInfo = "No se determinó Si/No en el PDF";
}

// --- Rack de Compresores / Gas Cooler: una sola visita cubre varias filas
// (todas las de frecuencia "Mensual" bajo esa categoría), todas en la misma fecha. ---
function cronoResolveCategoriaMatch(item, categoria) {
  const rows = cronoXlsm.rowIndex.filter(r => r.textC === categoria && r.textI === "MENSUAL");
  if (!rows.length) {
    item.status = "warn";
    item.matchInfo = `No se encontraron filas "Mensual" para ${categoria}`;
    return;
  }

  if (item.activityStatus === "ejecutado") {
    const ymd = dateToYMD(item.fechaEfectiva);
    const col = cronoXlsm.dateColMap[ymd];
    if (!col) {
      item.status = "warn";
      item.matchInfo = "Fecha fuera del rango del Excel";
      return;
    }
    rows.forEach(r => item.writes.push({ celda: `${col}${r.row}`, markValue: "E" }));
    item.status = "ok";
    item.matchInfo = `${categoria} · ${rows.length} fila(s) · ejecutado`;
  } else if (item.activityStatus === "no_ejecutado") {
    const year = item.fechaEfectiva.getUTCFullYear();
    const month = item.fechaEfectiva.getUTCMonth() + 1;
    rows.forEach(r => {
      const found = cronoFindScheduledPColumn(cronoXlsm.sheetXml, cronoXlsm.sharedStrings, cronoXlsm.dateColMap, r.row, year, month);
      if (found) item.writes.push({ celda: `${found.col}${r.row}`, markValue: "X" });
    });
    if (!item.writes.length) {
      item.status = "warn";
      item.matchInfo = "No había P programada ese mes en ninguna fila";
      return;
    }
    item.status = "ok";
    item.matchInfo = `${categoria} · ${item.writes.length} fila(s) · no ejecutado`;
  } else {
    item.status = "warn";
    item.matchInfo = "No se determinó Si/No en el PDF";
    return;
  }

  // Los informes "Predictivo del Sistema" (Red de Refrigeración CO2) no llegan
  // en formato AUVO estándar — se marcan manualmente el mismo día del Rack.
  if (categoria === "RACK DE COMPRESORES" && item.activityStatus === "ejecutado") {
    item.predictivoOptions = cronoXlsm.rowIndex
      .filter(r => r.textC === "RED DE REFRIGERACION CO2" && r.textI)
      .map(r => ({ row: r.row, label: r.textBDisplay, checked: false }));
  }
}

function cronoReprocessAll() {
  cronoItems.forEach(item => {
    if (item.equipoTextPdf && item.fechaHora) {
      cronoResolveMatch(item);
      cronoRenderRow(item);
    }
  });
  updateCronoToolbar();
}

/* ---------------------------------------------------------------------- */
/* Render                                                                   */
/* ---------------------------------------------------------------------- */
const cronoRowTemplate = document.getElementById("cronoRowTemplate");
const cronoRowElements = new Map();

function cronoRenderRow(item) {
  let row = cronoRowElements.get(item.id);
  if (!row) {
    row = cronoRowTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.id = item.id;
    cronoRowElements.set(item.id, row);
    cronoResultsEl.prepend(row);
    row.querySelector(".result-row__remove").addEventListener("click", () => cronoRemoveItem(item.id));
  }

  row.dataset.state = item.status;
  row.querySelector(".result-row__filename--original").textContent = item.file.name;

  const chipEquipo = row.querySelector(".crono-chip-equipo");
  const chipFecha = row.querySelector(".crono-chip-fecha");
  const chipCelda = row.querySelector(".crono-chip-celda");

  if (item.status === "loading") {
    chipEquipo.textContent = "…"; chipEquipo.classList.remove("chip--found", "chip--missing");
    chipFecha.textContent = "…"; chipFecha.classList.remove("chip--found", "chip--missing");
    chipCelda.textContent = "…"; chipCelda.classList.remove("chip--found", "chip--missing");
  } else if (item.status === "error") {
    chipEquipo.textContent = "no se pudo leer el PDF"; chipEquipo.classList.add("chip--missing");
    chipFecha.textContent = ""; chipCelda.textContent = "";
  } else {
    chipEquipo.textContent = item.equipoTextPdf || "sin equipo";
    chipEquipo.classList.toggle("chip--found", !!item.equipoTextPdf);

    const fh = item.fechaHora;
    const efectivaTxt = item.fechaEfectiva ? dateToYMD(item.fechaEfectiva).split("-").reverse().join("-") : "?";
    chipFecha.textContent = fh ? `${fh.ddmmyyyy} ${String(fh.hh).padStart(2,"0")}:${String(fh.mm).padStart(2,"0")} → ${efectivaTxt}` : "sin fecha";
    chipFecha.classList.toggle("chip--found", !!fh);

    const writes = item.writes || [];
    if (item.status === "ok" && writes.length) {
      const preview = writes.length === 1
        ? `${writes[0].celda} = "${writes[0].markValue}"`
        : `${writes.length} celdas = "${writes[0].markValue}"`;
      chipCelda.textContent = `${preview} (${item.matchInfo})`;
      chipCelda.classList.add("chip--found");
      chipCelda.classList.remove("chip--missing");
    } else {
      chipCelda.textContent = item.matchInfo || "sin cruzar";
      chipCelda.classList.add("chip--missing");
      chipCelda.classList.remove("chip--found");
    }
  }

  cronoRenderPredictivoChecklist(row, item);

  const statusText = row.querySelector(".status-text");
  statusText.textContent =
    item.status === "loading" ? "Leyendo…" :
    item.status === "ok" ? "Listo para aplicar" :
    item.status === "warn" ? "Revisar" :
    "Error";
}

/* Checklist manual para "Predictivo del Sistema", ligado a la fecha del Rack */
function cronoRenderPredictivoChecklist(row, item) {
  let box = row.querySelector(".predictivo-box");
  if (!item.predictivoOptions) {
    if (box) box.remove();
    return;
  }
  if (!box) {
    box = document.createElement("div");
    box.className = "predictivo-box";
    box.innerHTML = `<p class="predictivo-box__title">Predictivo del Sistema realizado en esta visita (opcional):</p>`;
    item.predictivoOptions.forEach((opt, idx) => {
      const label = document.createElement("label");
      label.className = "predictivo-box__item";
      label.innerHTML = `<input type="checkbox" data-idx="${idx}"> <span>${opt.label}</span>`;
      label.querySelector("input").addEventListener("change", (e) => {
        opt.checked = e.target.checked;
        cronoSyncPredictivoWrites(item);
      });
      box.appendChild(label);
    });
    row.appendChild(box);
  }
}

function cronoSyncPredictivoWrites(item) {
  if (!item.predictivoOptions) return;
  const ymd = dateToYMD(item.fechaEfectiva);
  const col = cronoXlsm.dateColMap[ymd];
  item.predictivoWrites = [];
  if (!col) return;
  item.predictivoOptions.forEach(opt => {
    if (opt.checked) item.predictivoWrites.push({ celda: `${col}${opt.row}`, markValue: "E" });
  });
  updateCronoToolbar();
}

function cronoRemoveItem(id) {
  const idx = cronoItems.findIndex(i => i.id === id);
  if (idx === -1) return;
  cronoItems.splice(idx, 1);
  const row = cronoRowElements.get(id);
  if (row) row.remove();
  cronoRowElements.delete(id);
  updateCronoToolbar();
}

document.getElementById("cronoClearBtn").addEventListener("click", () => {
  cronoItems = [];
  cronoRowElements.clear();
  cronoResultsEl.innerHTML = "";
  cronoToolbar.hidden = true;
  updateCronoToolbar();
});

function updateCronoToolbar() {
  const total = cronoItems.length;
  const ok = cronoItems.filter(i => i.status === "ok").length;
  const warn = total - ok;
  const totalCells = cronoItems.reduce((acc, i) => acc + (i.writes ? i.writes.length : 0) + (i.predictivoWrites ? i.predictivoWrites.length : 0), 0);

  document.getElementById("cronoStatTotal").textContent = total;
  document.getElementById("cronoStatOk").textContent = `${ok} cruzados`;
  document.getElementById("cronoStatWarn").textContent = `${warn} sin coincidencia`;

  applyCronoBtn.disabled = !cronoXlsm || totalCells === 0;
  cronoApplyHint.textContent = !cronoXlsm
    ? "Falta subir el Excel."
    : totalCells === 0
      ? "Ningún informe tiene un cruce válido todavía."
      : `Se escribirán ${totalCells} celda(s) (E o X según corresponda).`;
}

/* ---------------------------------------------------------------------- */
/* Aplicar y descargar                                                     */
/* ---------------------------------------------------------------------- */
applyCronoBtn.addEventListener("click", async () => {
  if (!cronoXlsm) return;
  applyCronoBtn.disabled = true;
  applyCronoBtn.textContent = "Aplicando…";

  let xml = cronoXlsm.sheetXml;
  let applied = 0;
  const failed = [];

  for (const item of cronoItems) {
    if (item.status !== "ok") continue;
    const allWrites = [...(item.writes || []), ...(item.predictivoWrites || [])];
    for (const w of allWrites) {
      const result = cronoWriteCell(xml, w.celda, w.markValue);
      if (result.found) {
        xml = result.xml;
        applied++;
      } else {
        failed.push(w.celda);
      }
    }
  }

  cronoXlsm.zip.file(cronoXlsm.sheetPath, xml);
  const blob = await cronoXlsm.zip.generateAsync({ type: "blob" });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const baseName = cronoXlsm.fileName.replace(/\.xlsm$/i, "");
  a.download = `${baseName}_actualizado.xlsm`;
  a.click();
  URL.revokeObjectURL(url);

  applyCronoBtn.textContent = "Generar Excel actualizado";
  applyCronoBtn.disabled = false;

  if (failed.length) {
    alert(`Se aplicaron ${applied} celda(s). ${failed.length} no se encontraron en el archivo: ${failed.join(", ")}`);
  }
});
