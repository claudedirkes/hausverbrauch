// Google Apps Script "Hausverbrauch" – im Sheet unter Erweiterungen > Apps Script einfügen.
// doPost: nimmt Werte der ESP32-Bridge entgegen. doGet: liefert JSON für die WebApp.

const WRITE_KEY = 'HIER_EIGENEN_KEY_EINTRAGEN';   // gleicher Wert wie WRITE_KEY in der Firmware
const TZ = 'Europe/Luxembourg';
const KOPF_AKTUELL = ['Messzeitpunkt', 'Strom Bezug (kWh)', 'Strom Einspeisung (kWh)', 'Leistung (W)',
                      'L1 (W)', 'L2 (W)', 'L3 (W)', 'Gas (m³)', 'Wasser (m³)',
                      'L1 (V)', 'L2 (V)', 'L3 (V)', 'L1 (A)', 'L2 (A)', 'L3 (A)',
                      'Gas abgelesen', 'Wasser abgelesen',
                      'Einbrüche L1', 'Einbrüche L2', 'Einbrüche L3',
                      'Überspannung L1', 'Überspannung L2', 'Überspannung L3', 'Stromausfälle',
                      'Außentemp. Diekirch (°C)'];
const LAT = 49.868, LON = 6.159;   // Diekirch
const KOPF_TAGE = ['Datum', 'Strom Bezug (kWh)', 'Strom Einspeisung (kWh)', 'Gas (m³)', 'Wasser (m³)',
                   'Strom über Referenz (kWh)'];
// Preise: eine Zeile pro Preisänderung. Ein neuer Preis gilt ab seinem Datum, ältere Tage behalten den alten Preis.
const KOPF_PREISE = ['Medium', 'Preis (€)', 'Einheit', 'gültig ab'];
// "referenz" = Referenzleistung in kW (Strom). Verbrauch über Referenz je Viertelstunde = max(0, kWh − kW × 0,25 h)
const START_PREISE = [['strom', 0.1793, '€/kWh'], ['gas', 0.431, '€/m³'], ['wasser', 10.45, '€/m³'], ['referenz', 3, 'kW']];
const EINHEIT = { strom: '€/kWh', gas: '€/m³', wasser: '€/m³', referenz: 'kW', geteilt: '€/kWh' };

// Einmal manuell ausführen: setzt/aktualisiert die Kopfzeilen. Vorhandene Daten bleiben erhalten.
function einrichten() {
  const ss = SpreadsheetApp.getActive();
  [['Aktuell', KOPF_AKTUELL], ['Tage', KOPF_TAGE]].forEach(([name, kopf]) => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, kopf.length).setValues([kopf]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  preiseBlatt();
}

// Blatt "Preise" holen; fehlt es, wird es mit den Startpreisen angelegt
function preiseBlatt() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName('Preise');
  if (!sh) {
    sh = ss.insertSheet('Preise');
    sh.getRange(1, 1, 1, KOPF_PREISE.length).setValues([KOPF_PREISE]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  // fehlende Einträge (z. B. Referenzleistung bei älterem Blatt) ergänzen
  const n = sh.getLastRow() - 1;
  const da = n > 0 ? sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0]).trim().toLowerCase()) : [];
  START_PREISE.filter(p => da.indexOf(p[0]) < 0).forEach(p => {
    const z = sh.getLastRow() + 1;
    sh.getRange(z, 4).setNumberFormat('@');
    sh.getRange(z, 1, 1, 4).setValues([p.concat('2000-01-01')]);
  });
  return sh;
}

// Historie (Leneda-Import): eine Zeile pro Tag. Eigene P1-Messungen im Blatt "Tage" haben in der WebApp Vorrang.
// "Strom geteilt" = Leneda OBIS 1-65:1.29.x (Verbrauch gedeckt durch Energieteilung); Rest vom Lieferanten = Bezug − geteilt
const KOPF_HIST = ['Datum', 'Strom Bezug (kWh)', 'Strom über Referenz (kWh)', 'Gas (m³)', 'Strom geteilt (kWh)'];
const HIST_SPALTE = { strom: 1, gas: 3, geteilt: 4 };   // Index in KOPF_HIST

function historieBlatt() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName('Historie');
  if (!sh) {
    sh = ss.insertSheet('Historie');
    sh.setFrozenRows(1);
  }
  sh.getRange(1, 1, 1, KOPF_HIST.length).setValues([KOPF_HIST]).setFontWeight('bold');   // neue Spalten ergänzen
  return sh;
}

// Tageswerte aus der WebApp übernehmen: d.medium = 'strom' | 'gas', d.tage = [{datum, wert, ueber}]
// Vorhandene Tage werden überschrieben (kein Doppeltzählen), andere Spalten bleiben unberührt.
function historieSpeichern(d) {
  const sp = HIST_SPALTE[d.medium];
  if (sp === undefined || !Array.isArray(d.tage)) return antwort({ ok: false, fehler: 'ungültiger Import' });
  const sh = historieBlatt();
  const n = sh.getLastRow() - 1;
  const zeilen = n > 0 ? sh.getRange(2, 1, n, KOPF_HIST.length).getValues() : [];
  const map = {};
  zeilen.forEach(r => {
    while (r.length < KOPF_HIST.length) r.push('');
    const k = r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd') : String(r[0]);
    if (k) map[k] = r;
  });
  d.tage.forEach(t => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.datum)) return;
    const r = map[t.datum] || (map[t.datum] = KOPF_HIST.map((_, i) => i ? '' : t.datum));
    r[sp] = Number(t.wert);
    if (d.medium === 'strom') r[2] = Number(t.ueber) || 0;
  });
  const alle = Object.keys(map).sort().map(k => { const r = map[k]; r[0] = k; return r; });
  sh.getRange(2, 1, alle.length, 1).setNumberFormat('@');
  sh.getRange(2, 1, alle.length, KOPF_HIST.length).setValues(alle);
  return antwort({ ok: true, tage: d.tage.length });
}

// Wert aus "Preise", der am Tag datum (yyyy-MM-dd) galt
function wertAm(medium, datum) {
  const sh = preiseBlatt();
  const n = sh.getLastRow() - 1;
  if (n < 1) return NaN;
  let best = null;
  sh.getRange(2, 1, n, 4).getValues().forEach(r => {
    const ab = r[3] instanceof Date ? Utilities.formatDate(r[3], TZ, 'yyyy-MM-dd') : String(r[3]);
    if (String(r[0]).trim().toLowerCase() === medium && ab <= datum && (!best || ab >= best.ab))
      best = { ab, wert: parseFloat(String(r[1]).replace(',', '.')) };
  });
  return best ? best.wert : NaN;
}

// kWh über Referenz für eine Viertelstunde (0, wenn Abstand kein 15-Min.-Schritt ist)
function ueberReferenz(tA, kwhA, tB, kwhB, refKw) {
  const min = (tB - tA) / 60000;
  if (min < 14 || min > 16 || kwhA === '' || kwhB === '' || isNaN(refKw)) return 0;
  return Math.max(0, (Number(kwhB) - Number(kwhA)) - refKw * 0.25);
}

// Einmal manuell ausführen: rechnet "Strom über Referenz" für alle Tage aus dem Blatt "Aktuell" neu
function referenzNachrechnen() {
  const ss = SpreadsheetApp.getActive();
  const akt = ss.getSheetByName('Aktuell'), tage = ss.getSheetByName('Tage');
  tage.getRange(1, 6).setValue(KOPF_TAGE[5]).setFontWeight('bold');
  const n = akt.getLastRow() - 1;
  if (n < 2) return;
  const w = akt.getRange(2, 1, n, 2).getValues();
  const proTag = {};
  for (let i = 1; i < w.length; i++) {
    if (!(w[i][0] instanceof Date) || !(w[i - 1][0] instanceof Date)) continue;
    const datum = Utilities.formatDate(new Date(w[i][0].getTime() - 1000), TZ, 'yyyy-MM-dd');
    const ue = ueberReferenz(w[i - 1][0], w[i - 1][1], w[i][0], w[i][1], wertAm('referenz', datum));
    proTag[datum] = (proTag[datum] || 0) + ue;
  }
  const nT = tage.getLastRow() - 1;
  if (nT < 1) return;
  const daten = tage.getRange(2, 1, nT, 1).getDisplayValues();
  tage.getRange(2, 6, nT, 1).setValues(daten.map(r => [proTag[r[0]] !== undefined ? +proTag[r[0]].toFixed(3) : '']));
  console.log('Fertig: ' + Object.keys(proTag).length + ' Tage berechnet');
}

// Neuen Preis speichern (aus der WebApp). Gleiches Medium am selben Tag: Zeile überschreiben.
function preisSpeichern(d) {
  const medium = String(d.medium);
  const preis = Number(String(d.preis).replace(',', '.'));
  if (!EINHEIT[medium] || !(preis >= 0)) return antwort({ ok: false, fehler: 'ungültiger Preis' });
  const sh = preiseBlatt();
  const ab = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const n = sh.getLastRow() - 1;
  const werte = n > 0 ? sh.getRange(2, 1, n, 4).getDisplayValues() : [];
  const i = werte.findIndex(r => r[0] === medium && r[3] === ab);
  const zeile = i >= 0 ? i + 2 : sh.getLastRow() + 1;
  sh.getRange(zeile, 4).setNumberFormat('@');
  sh.getRange(zeile, 1, 1, 4).setValues([[medium, preis, EINHEIT[medium], ab]]);
  return antwort({ ok: true });
}

function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  if (d.key !== WRITE_KEY) return antwort({ ok: false, fehler: 'key' });
  if (d.aktion === 'preis') return preisSpeichern(d);
  if (d.aktion === 'historie') return historieSpeichern(d);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActive();
    // Messzeitpunkt = Rasterpunkt der Bridge (:00/:15/:30/:45, wie Leneda). Ältere Firmware: Empfangszeit.
    const jetzt = d.slot ? new Date(Number(d.slot) * 1000) : new Date();
    const zahl = v => (v === undefined || v === null) ? '' : Number(v);

    // Doppelte Meldung für denselben Rasterpunkt ignorieren (z. B. Wiederholung nach Zeitüberschreitung)
    const props = PropertiesService.getScriptProperties();
    if (d.slot && props.getProperty('letzterSlot') === String(d.slot)) return antwort({ ok: true, doppelt: true });
    if (d.slot) props.setProperty('letzterSlot', String(d.slot));

    // Außentemperatur stündlich (nur zur vollen Stunde)
    const temp = Utilities.formatDate(jetzt, TZ, 'mm') === '00' ? aussenTemperatur() : '';

    // kWh über Referenzleistung in dieser Viertelstunde (Vergleich mit der vorigen Messung)
    const akt = ss.getSheetByName('Aktuell');
    const datum = Utilities.formatDate(new Date(jetzt.getTime() - 1000), TZ, 'yyyy-MM-dd');
    let ueber = 0;
    if (akt.getLastRow() > 1) {
      const vor = akt.getRange(akt.getLastRow(), 1, 1, 2).getValues()[0];
      if (vor[0] instanceof Date)
        ueber = ueberReferenz(vor[0], vor[1], jetzt, zahl(d.strom_import_kwh), wertAm('referenz', datum));
    }

    akt.appendRow([
      jetzt, zahl(d.strom_import_kwh), zahl(d.strom_export_kwh), zahl(d.leistung_w),
      zahl(d.l1_w), zahl(d.l2_w), zahl(d.l3_w), zahl(d.gas_m3), zahl(d.wasser_m3),
      zahl(d.l1_v), zahl(d.l2_v), zahl(d.l3_v), zahl(d.l1_a), zahl(d.l2_a), zahl(d.l3_a),
      zeitstempel(d.gas_ts), zeitstempel(d.wasser_ts),
      zahl(d.sag_l1), zahl(d.sag_l2), zahl(d.sag_l3),
      zahl(d.swell_l1), zahl(d.swell_l2), zahl(d.swell_l3), zahl(d.stromausfall), temp
    ]);

    // Tagesblatt: eine Zeile pro Tag mit dem Endstand. Der Stand um 00:00 ist der Endstand des Vortags
    // (Tagesverbrauch = 00:00 bis 00:00, wie Leneda), deshalb 1 Sekunde zurückrechnen.
    const tage = ss.getSheetByName('Tage');
    if (tage.getRange(1, 6).getValue() === '') tage.getRange(1, 6).setValue(KOPF_TAGE[5]).setFontWeight('bold');
    const zeile = [datum, zahl(d.strom_import_kwh), zahl(d.strom_export_kwh), zahl(d.gas_m3), zahl(d.wasser_m3)];
    const letzte = tage.getLastRow();
    const letztesDatum = letzte > 1 ? String(tage.getRange(letzte, 1).getDisplayValue()) : '';
    if (letztesDatum === datum) {
      const bisher = Number(tage.getRange(letzte, 6).getValue()) || 0;
      zeile.push(+(bisher + ueber).toFixed(3));
      tage.getRange(letzte, 1, 1, zeile.length).setValues([zeile]);
    } else {
      zeile.push(+ueber.toFixed(3));
      tage.appendRow(zeile);
      tage.getRange(tage.getLastRow(), 1).setNumberFormat('@');  // Datum als Text speichern
      tage.getRange(tage.getLastRow(), 1).setValue(datum);
    }
  } finally {
    lock.releaseLock();
  }
  return antwort({ ok: true });
}

function doGet() {
  const ss = SpreadsheetApp.getActive();
  const akt = ss.getSheetByName('Aktuell');
  const tage = ss.getSheetByName('Tage');

  // letzte 96 Messungen (= 24 h) für Leistungsverlauf
  const nA = Math.max(0, akt.getLastRow() - 1);
  const anzA = Math.min(nA, 96);
  const messungen = anzA ? akt.getRange(akt.getLastRow() - anzA + 1, 1, anzA, KOPF_AKTUELL.length).getValues() : [];

  // bis zu 400 Tage
  const nT = Math.max(0, tage.getLastRow() - 1);
  const anzT = Math.min(nT, 400);
  const tageWerte = anzT ? tage.getRange(tage.getLastRow() - anzT + 1, 1, anzT, 6).getDisplayValues() : [];

  const pr = preiseBlatt();
  const nP = Math.max(0, pr.getLastRow() - 1);
  const preise = nP ? pr.getRange(2, 1, nP, 4).getValues()
    .map(r => ({ medium: String(r[0]).trim().toLowerCase(), preis: parseFloat(String(r[1]).replace(',', '.')),
                 ab: r[3] instanceof Date ? Utilities.formatDate(r[3], TZ, 'yyyy-MM-dd') : String(r[3]) }))
    .filter(p => p.medium && !isNaN(p.preis)) : [];

  const hi = ss.getSheetByName('Historie');
  const nH = hi ? Math.max(0, hi.getLastRow() - 1) : 0;
  const zahlOderNull = v => (v === '' || v === null) ? null : Number(v);
  const historie = nH ? hi.getRange(2, 1, nH, KOPF_HIST.length).getValues().map(r => ({
    datum: r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd') : String(r[0]),
    strom: zahlOderNull(r[1]), ueber: zahlOderNull(r[2]), gas: zahlOderNull(r[3]), geteilt: zahlOderNull(r[4])
  })) : [];

  return antwort({
    ok: true,
    preise: preise,
    historie: historie,
    messungen: messungen.map(r => ({
      zeit: r[0] instanceof Date ? r[0].toISOString() : r[0],
      import: r[1], export: r[2], leistung: r[3], l1: r[4], l2: r[5], l3: r[6], gas: r[7], wasser: r[8],
      u1: r[9], u2: r[10], u3: r[11], i1: r[12], i2: r[13], i3: r[14],
      gasZeit: r[15] instanceof Date ? r[15].toISOString() : r[15],
      wasserZeit: r[16] instanceof Date ? r[16].toISOString() : r[16],
      sag1: r[17], sag2: r[18], sag3: r[19], swell1: r[20], swell2: r[21], swell3: r[22], ausfaelle: r[23],
      temp: r[24]
    })),
    tage: tageWerte.map(r => ({
      datum: r[0],
      import: parseFloat(String(r[1]).replace(',', '.')),
      export: parseFloat(String(r[2]).replace(',', '.')),
      gas: parseFloat(String(r[3]).replace(',', '.')),
      wasser: parseFloat(String(r[4]).replace(',', '.')),
      ueber: parseFloat(String(r[5]).replace(',', '.'))
    }))
  });
}

// HomeWizard-Zeitstempel (JJMMTThhmmss, Ortszeit) in Datum umwandeln
function zeitstempel(v) {
  if (v === undefined || v === null || v === '') return '';
  const t = String(v).padStart(12, '0');
  return Utilities.parseDate(t, TZ, 'yyMMddHHmmss');
}

// Aktuelle Außentemperatur Diekirch (Open-Meteo). Bei Fehler leer, damit das Speichern weiterläuft.
function aussenTemperatur() {
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + LAT + '&longitude=' + LON +
                '&current=temperature_2m&timezone=' + encodeURIComponent(TZ);
    const j = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText());
    return (j.current && j.current.temperature_2m !== null) ? j.current.temperature_2m : '';
  } catch (err) {
    console.log('Temperatur: ' + err);
    return '';
  }
}

// Einmal manuell ausführen, um die Berechtigung für externe Abrufe zu erteilen und den Abruf zu testen
function testTemperatur() {
  console.log('Außentemperatur Diekirch: ' + aussenTemperatur() + ' °C');
}

function antwort(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
