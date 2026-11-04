// Google Apps Script "Hausverbrauch" – im Sheet unter Erweiterungen > Apps Script einfügen.
// doPost: nimmt Werte der ESP32-Bridge entgegen. doGet: liefert JSON für die WebApp.

const WRITE_KEY = 'HIER_EIGENEN_KEY_EINTRAGEN';   // gleicher Wert wie WRITE_KEY in der Firmware
const TZ = 'Europe/Luxembourg';
const KOPF_AKTUELL = ['Messzeitpunkt', 'Strom Bezug (kWh)', 'Leistung (W)',
                      'L1 (W)', 'L2 (W)', 'L3 (W)', 'Gas (m³)', 'Wasser (m³)',
                      'L1 (V)', 'L2 (V)', 'L3 (V)', 'L1 (A)', 'L2 (A)', 'L3 (A)',
                      'Gas abgelesen', 'Wasser abgelesen',
                      'Einbrüche L1', 'Einbrüche L2', 'Einbrüche L3',
                      'Überspannung L1', 'Überspannung L2', 'Überspannung L3', 'Stromausfälle',
                      'Außentemp. Diekirch (°C)'];
const LAT = 49.868, LON = 6.159;   // Diekirch
const KOPF_TAGE = ['Datum', 'Strom Bezug (kWh)', 'Gas (m³)', 'Wasser (m³)',
                   'Strom über Referenz (kWh)'];
// Preise: eine Zeile pro Preisänderung. Ein neuer Preis gilt ab seinem Datum, ältere Tage behalten den alten Preis.
const KOPF_PREISE = ['Medium', 'Preis (€)', 'Einheit', 'gültig ab'];
// "referenz" = Referenzleistung in kW (Strom). Verbrauch über Referenz je Viertelstunde = max(0, kWh − kW × 0,25 h)
const START_PREISE = [['strom', 0.1793, '€/kWh'], ['gas', 0.431, '€/m³'], ['wasser', 10.45, '€/m³'], ['referenz', 3, 'kW']];
const EINHEIT = { strom: '€/kWh', gas: '€/m³', wasser: '€/m³', referenz: 'kW', geteilt: '€/kWh' };

// Einspeisung wird nicht mehr erfasst: alte Spalte C ("Strom Einspeisung") in "Aktuell" und "Tage" löschen.
// Läuft automatisch beim ersten Aufruf nach dem Update (nur solange die Spalte noch existiert).
function einspeisungEntfernen() {
  const ss = SpreadsheetApp.getActive();
  ['Aktuell', 'Tage'].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh && String(sh.getRange(1, 3).getValue()).indexOf('Einspeisung') >= 0) sh.deleteColumn(3);
  });
}

// Einmal manuell ausführen: setzt/aktualisiert die Kopfzeilen. Vorhandene Daten bleiben erhalten.
function einrichten() {
  einspeisungEntfernen();
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
const KOPF_HIST = ['Datum', 'Strom Bezug (kWh)', 'Strom über Referenz (kWh)', 'Gas (m³)', 'Strom geteilt (kWh)', 'Wasser (m³)'];
const HIST_SPALTE = { strom: 1, gas: 3, geteilt: 4, wasser: 5 };   // Index in KOPF_HIST

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
  einspeisungEntfernen();
  tage.getRange(1, 5).setValue(KOPF_TAGE[4]).setFontWeight('bold');
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
  tage.getRange(2, 5, nT, 1).setValues(daten.map(r => [proTag[r[0]] !== undefined ? +proTag[r[0]].toFixed(3) : '']));
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
  if (d.aktion === 'leneda') return lenedaTagSpeichern(d);
  if (d.aktion === 'rechnung') return rechnungSpeichern(d);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    einspeisungEntfernen();
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
      jetzt, zahl(d.strom_import_kwh), zahl(d.leistung_w),
      zahl(d.l1_w), zahl(d.l2_w), zahl(d.l3_w), zahl(d.gas_m3), zahl(d.wasser_m3),
      zahl(d.l1_v), zahl(d.l2_v), zahl(d.l3_v), zahl(d.l1_a), zahl(d.l2_a), zahl(d.l3_a),
      zeitstempel(d.gas_ts), zeitstempel(d.wasser_ts),
      zahl(d.sag_l1), zahl(d.sag_l2), zahl(d.sag_l3),
      zahl(d.swell_l1), zahl(d.swell_l2), zahl(d.swell_l3), zahl(d.stromausfall), temp
    ]);

    // Tagesblatt: eine Zeile pro Tag mit dem Endstand. Der Stand um 00:00 ist der Endstand des Vortags
    // (Tagesverbrauch = 00:00 bis 00:00, wie Leneda), deshalb 1 Sekunde zurückrechnen.
    const tage = ss.getSheetByName('Tage');
    if (tage.getRange(1, 5).getValue() === '') tage.getRange(1, 5).setValue(KOPF_TAGE[4]).setFontWeight('bold');
    const zeile = [datum, zahl(d.strom_import_kwh), zahl(d.gas_m3), zahl(d.wasser_m3)];
    const letzte = tage.getLastRow();
    const letztesDatum = letzte > 1 ? String(tage.getRange(letzte, 1).getDisplayValue()) : '';
    if (letztesDatum === datum) {
      const bisher = Number(tage.getRange(letzte, 5).getValue()) || 0;
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

// Eine Zeile aus "Aktuell" als JSON-Objekt für die WebApp
function messungJson(r) {
  return {
    zeit: r[0] instanceof Date ? r[0].toISOString() : r[0],
    import: r[1], leistung: r[2], l1: r[3], l2: r[4], l3: r[5], gas: r[6], wasser: r[7],
    u1: r[8], u2: r[9], u3: r[10], i1: r[11], i2: r[12], i3: r[13],
    gasZeit: r[14] instanceof Date ? r[14].toISOString() : r[14],
    wasserZeit: r[15] instanceof Date ? r[15].toISOString() : r[15],
    sag1: r[16], sag2: r[17], sag3: r[18], swell1: r[19], swell2: r[20], swell3: r[21], ausfaelle: r[22],
    temp: r[23]
  };
}

// Eigenes Diagramm: Werte von p.von bis p.bis (yyyy-MM-dd).
// p.aufl = 'viertel': alle Messungen (plus eine danach für den letzten Viertelstunden-Verbrauch).
// p.aufl = 'tag': je Tag Verbrauch (Tage-Blatt, sonst Historie) und Tagesmittel der Momentanwerte.
const MITTEL = { leistung: 2, l1: 3, l2: 4, l3: 5, u1: 8, u2: 9, u3: 10, i1: 11, i2: 12, i3: 13, temp: 23 };
function bereich(p) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.von) || !/^\d{4}-\d{2}-\d{2}$/.test(p.bis) || p.von > p.bis)
    return antwort({ ok: false, fehler: 'Datum ungültig' });
  const ss = SpreadsheetApp.getActive();
  const akt = ss.getSheetByName('Aktuell');
  const tagBeginn = d => Utilities.parseDate(d, TZ, 'yyyy-MM-dd').getTime();
  const naechsterTag = d => Utilities.formatDate(new Date(tagBeginn(d) + 36 * 3600e3), TZ, 'yyyy-MM-dd');
  const start = tagBeginn(p.von), ende = tagBeginn(naechsterTag(p.bis));
  const n = Math.max(0, akt.getLastRow() - 1);
  const zeiten = n ? akt.getRange(2, 1, n, 1).getValues().map(r => r[0] instanceof Date ? r[0].getTime() : NaN) : [];

  if (p.aufl === 'viertel') {
    let lo = -1, hi = -1;
    zeiten.forEach((t, i) => { if (t >= start && t < ende) { if (lo < 0) lo = i; hi = i; } });
    if (lo < 0) return antwort({ ok: true, aufl: 'viertel', messungen: [] });
    hi = Math.min(hi + 1, n - 1);   // eine Messung danach für den letzten Verbrauch
    const zeilen = akt.getRange(lo + 2, 1, hi - lo + 1, KOPF_AKTUELL.length).getValues();
    return antwort({ ok: true, aufl: 'viertel', messungen: zeilen.map(messungJson) });
  }

  // Tagesmittel: Messung um 00:00 gehört zum Vortag (wie im Blatt "Tage")
  const tage = {};
  const tag = d => tage[d] || (tage[d] = { datum: d, summe: {}, anzahl: {} });
  let lo = -1, hi = -1;
  zeiten.forEach((t, i) => { if (t > start && t <= ende) { if (lo < 0) lo = i; hi = i; } });
  if (lo >= 0) {
    const zeilen = akt.getRange(lo + 2, 1, hi - lo + 1, KOPF_AKTUELL.length).getValues();
    let key = '', kVon = 0, kBis = 0;
    zeilen.forEach(r => {
      if (!(r[0] instanceof Date)) return;
      const t = r[0].getTime() - 1000;
      if (!(t >= kVon && t < kBis)) {
        key = Utilities.formatDate(new Date(t), TZ, 'yyyy-MM-dd');
        kVon = tagBeginn(key); kBis = tagBeginn(naechsterTag(key));
      }
      const o = tag(key);
      Object.keys(MITTEL).forEach(f => {
        const v = r[MITTEL[f]];
        if (v === '' || v === null || isNaN(Number(v))) return;
        o.summe[f] = (o.summe[f] || 0) + Number(v);
        o.anzahl[f] = (o.anzahl[f] || 0) + 1;
      });
    });
  }

  // Verbrauch je Tag: Endstand minus Endstand des Vortags, fehlende Tage aus der Historie
  const zahl = v => { const x = parseFloat(String(v).replace(',', '.')); return isNaN(x) ? null : x; };
  const tb = ss.getSheetByName('Tage');
  const nT = Math.max(0, tb.getLastRow() - 1);
  const tw = nT ? tb.getRange(2, 1, nT, 4).getDisplayValues() : [];
  const verbrauch = {};
  for (let i = 1; i < tw.length; i++) {
    const d = tw[i][0];
    if (d < p.von || d > p.bis) continue;
    const v = verbrauch[d] = {};
    [['strom', 1], ['gas', 2], ['wasser', 3]].forEach(([f, c]) => {
      const a = zahl(tw[i - 1][c]), b = zahl(tw[i][c]);
      if (a !== null && b !== null) v[f] = b - a;
    });
  }
  const hi2 = ss.getSheetByName('Historie');
  const nH = hi2 ? Math.max(0, hi2.getLastRow() - 1) : 0;
  if (nH) hi2.getRange(2, 1, nH, KOPF_HIST.length).getValues().forEach(r => {
    const d = r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd') : String(r[0]);
    if (d < p.von || d > p.bis) return;
    const v = verbrauch[d] || (verbrauch[d] = {});
    [['strom', 1], ['gas', 3], ['wasser', 5]].forEach(([f, c]) => {
      if (v[f] === undefined && zahl(r[c]) !== null) v[f] = zahl(r[c]);
    });
  });
  Object.keys(verbrauch).forEach(d => tag(d));

  const liste = Object.keys(tage).filter(d => d >= p.von && d <= p.bis).sort().map(d => {
    const o = tage[d], out = Object.assign({ datum: d }, verbrauch[d] || {});
    Object.keys(o.summe).forEach(f => out[f] = o.summe[f] / o.anzahl[f]);
    return out;
  });
  return antwort({ ok: true, aufl: 'tag', tage: liste });
}

// Für die Bridge: Tage zwischen von und bis (yyyy-MM-dd), bei denen Leneda die Aufteilung noch nicht geliefert hat
// (keine Viertelstunden für geteilt oder Rest, oder Tag fehlt). Nur ab dem ersten Tag mit geteiltem Strom.
function egLuecken(p) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.von) || !/^\d{4}-\d{2}-\d{2}$/.test(p.bis)) return antwort({ ok: false, fehler: 'Datum ungültig' });
  const sh = SpreadsheetApp.getActive().getSheetByName('Energiegemeinschaft');
  if (!sh || sh.getLastRow() < 2) return antwort({ ok: true, luecken: [] });
  const zeilen = sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues().map(r => ({
    d: r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd') : String(r[0]),
    nG: Number(r[8]) || 0, nR: Number(r[9]) || 0 }));
  const start = zeilen.filter(z => z.nG > 0).map(z => z.d).sort()[0];
  if (!start) return antwort({ ok: true, luecken: [] });
  const map = {};
  zeilen.forEach(z => map[z.d] = z);
  const luecken = [];
  let d = p.von < start ? start : p.von;
  while (d <= p.bis && luecken.length < 60) {
    const z = map[d];
    if (!z || z.nG === 0 || z.nR === 0) luecken.push(d);
    d = Utilities.formatDate(new Date(Utilities.parseDate(d, TZ, 'yyyy-MM-dd').getTime() + 36 * 3600e3), TZ, 'yyyy-MM-dd');
  }
  return antwort({ ok: true, luecken: luecken });
}

function doGet(e) {
  if (e && e.parameter && e.parameter.eglueken) return egLuecken(e.parameter);
  einspeisungEntfernen();
  if (e && e.parameter && e.parameter.von) return bereich(e.parameter);
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
  const tageWerte = anzT ? tage.getRange(tage.getLastRow() - anzT + 1, 1, anzT, 5).getDisplayValues() : [];

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
    strom: zahlOderNull(r[1]), ueber: zahlOderNull(r[2]), gas: zahlOderNull(r[3]), geteilt: zahlOderNull(r[4]), wasser: zahlOderNull(r[5])
  })) : [];

  // Tage ohne Strom in der Historie: Bezug aus dem Leneda-Abruf der Bridge (Blatt "Energiegemeinschaft") ergänzen,
  // z. B. Tage nach dem letzten CSV-Import und vor der ersten eigenen Messung
  // Zusätzlich je Tag die Leneda-Werte (Strom, Gas) für den Vergleich mit dem HomeWizard
  const eg = ss.getSheetByName('Energiegemeinschaft');
  const lenTage = [];
  if (eg && eg.getLastRow() > 1) {
    const hMap = {};
    historie.forEach(h => hMap[h.datum] = h);
    const nSp = Math.min(eg.getLastColumn(), KOPF_EG.length);
    eg.getRange(2, 1, eg.getLastRow() - 1, nSp).getValues().forEach(r => {
      const d = r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd') : String(r[0]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      const strom = zahlOderNull(r[1]);
      const nGas = Number(r[12]) || 0;
      const gas = nGas > 0 ? zahlOderNull(r[11]) : null;
      const einheit = String(r[13] || '');
      lenTage.push({ datum: d, strom: strom, gas: gas, einheit: einheit });
      const gasM3 = gas !== null && /^m(3|³)$/i.test(einheit);
      if (strom === null && !gasM3) return;
      const h = hMap[d] || (hMap[d] = historie[historie.push({ datum: d, strom: null, ueber: null, gas: null, geteilt: null, wasser: null }) - 1]);
      if (h.strom === null && strom !== null) h.strom = strom;
      if (h.gas === null && gasM3) h.gas = gas;
    });
    historie.sort((a, b) => a.datum < b.datum ? -1 : 1);
    lenTage.sort((a, b) => a.datum < b.datum ? -1 : 1);
  }

  return antwort({
    ok: true,
    eg: egMonate(),
    lenTage: lenTage.slice(-400),
    preise: preise,
    historie: historie,
    messungen: messungen.map(messungJson),
    tage: tageWerte.map(r => ({
      datum: r[0],
      import: parseFloat(String(r[1]).replace(',', '.')),
      gas: parseFloat(String(r[2]).replace(',', '.')),
      wasser: parseFloat(String(r[3]).replace(',', '.')),
      ueber: parseFloat(String(r[4]).replace(',', '.'))
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

// ==================== Energiegemeinschaft (Leneda über die Bridge) ====================
// Die Bridge schickt je Tag die Leneda-Summen: Bezug, geteilt Ebene 1-4 (AIR, ACR/ACF, CEL, CER/CEN),
// Rest für den Lieferanten und die Anzahl Viertelstunden. Im Blatt "Rechnungen EG" stehen die kWh
// aus den Rechnungen (Gemeinschaft und Lieferant) je Monat, eingetragen über die WebApp.
const KOPF_EG = ['Datum', 'Bezug (kWh)', 'Ebene 1 AIR (kWh)', 'Ebene 2 ACR/ACF (kWh)', 'Ebene 3 CEL (kWh)',
                 'Ebene 4 CER/CEN (kWh)', 'Rest Lieferant (kWh)', 'Viertelstunden Bezug', 'Viertelstunden geteilt',
                 'Viertelstunden Rest', 'abgerufen', 'Gas Leneda', 'Werte Gas', 'Einheit Gas'];
const KOPF_RE = ['Monat', 'Gemeinschaft (kWh)', 'Lieferant (kWh)'];

function blattMitKopf(name, kopf) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, kopf.length).setValues([kopf]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');
  }
  return sh;
}

// Zeile mit Schlüssel in Spalte A ersetzen oder anhängen (Blatt bleibt nach Spalte A sortiert)
function zeileSetzen(sh, zeile) {
  const n = sh.getLastRow() - 1;
  const keys = n > 0 ? sh.getRange(2, 1, n, 1).getDisplayValues().map(r => r[0]) : [];
  const i = keys.indexOf(zeile[0]);
  if (i >= 0) { sh.getRange(i + 2, 1, 1, zeile.length).setValues([zeile]); return; }
  sh.getRange(n + 2, 1, 1, zeile.length).setValues([zeile]);
  if (n > 0 && keys[n - 1] > zeile[0]) sh.getRange(2, 1, n + 1, sh.getLastColumn()).sort(1);
}

function lenedaTagSpeichern(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.datum)) return antwort({ ok: false, fehler: 'Datum ungültig' });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const z = v => (v === undefined || v === null) ? '' : Number(v);
    const sh = blattMitKopf('Energiegemeinschaft', KOPF_EG);
    if (sh.getRange(1, KOPF_EG.length).getValue() === '') sh.getRange(1, 1, 1, KOPF_EG.length).setValues([KOPF_EG]).setFontWeight('bold');
    zeileSetzen(sh, [d.datum, z(d.bezug), z(d.l1), z(d.l2), z(d.l3), z(d.l4), z(d.rest),
      z(d.nBezug), z(d.nGeteilt), z(d.nRest), Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'),
      z(d.gas), z(d.nGas), d.gasEinheit || '']);
  } finally {
    lock.releaseLock();
  }
  return antwort({ ok: true });
}

// Rechnungswerte eines Monats aus der WebApp (leer = löschen)
function rechnungSpeichern(d) {
  if (!/^\d{4}-\d{2}$/.test(d.monat)) return antwort({ ok: false, fehler: 'Monat ungültig' });
  const z = v => (v === '' || v === undefined || v === null) ? '' : Number(String(v).replace(',', '.'));
  const g = z(d.gemeinschaft), l = z(d.lieferant);
  if ((g !== '' && isNaN(g)) || (l !== '' && isNaN(l))) return antwort({ ok: false, fehler: 'ungültige Zahl' });
  zeileSetzen(blattMitKopf('Rechnungen EG', KOPF_RE), [d.monat, g, l]);
  return antwort({ ok: true });
}

// Monatssummen für die WebApp
function egMonate() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName('Energiegemeinschaft');
  const monate = {};
  const zahl = v => { const x = Number(v); return isNaN(x) ? 0 : x; };
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues().forEach(r => {
      const d = r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd') : String(r[0]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      const m = monate[d.slice(0, 7)] || (monate[d.slice(0, 7)] = { monat: d.slice(0, 7), bezug: 0, l1: 0, l2: 0, l3: 0, l4: 0, rest: 0,
                                                                     tage: 0, nBezug: 0, nGeteilt: 0, nRest: 0, bis: d });
      ['bezug', 'l1', 'l2', 'l3', 'l4', 'rest', 'nBezug', 'nGeteilt', 'nRest'].forEach((f, i) => m[f] += zahl(r[i + 1]));
      m.tage++;
      if (d > m.bis) m.bis = d;
    });
  }
  const re = ss.getSheetByName('Rechnungen EG');
  if (re && re.getLastRow() > 1) {
    re.getRange(2, 1, re.getLastRow() - 1, 3).getValues().forEach(r => {
      const k = r[0] instanceof Date ? Utilities.formatDate(r[0], TZ, 'yyyy-MM') : String(r[0]);
      const m = monate[k] || (monate[k] = { monat: k });
      m.rGemeinschaft = r[1] === '' ? null : Number(r[1]);
      m.rLieferant = r[2] === '' ? null : Number(r[2]);
    });
  }
  return Object.keys(monate).sort().map(k => monate[k]);
}

function antwort(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
