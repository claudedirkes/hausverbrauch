// Google Apps Script "Hausverbrauch" – im Sheet unter Erweiterungen > Apps Script einfügen.
// doPost: nimmt Werte der ESP32-Bridge entgegen. doGet: liefert JSON für die WebApp.

const WRITE_KEY = 'HIER_EIGENEN_KEY_EINTRAGEN';   // gleicher Wert wie WRITE_KEY in der Firmware
const TZ = 'Europe/Luxembourg';
const KOPF_AKTUELL = ['Empfangen', 'Strom Bezug (kWh)', 'Strom Einspeisung (kWh)', 'Leistung (W)',
                      'L1 (W)', 'L2 (W)', 'L3 (W)', 'Gas (m³)', 'Wasser (m³)',
                      'L1 (V)', 'L2 (V)', 'L3 (V)', 'L1 (A)', 'L2 (A)', 'L3 (A)',
                      'Gas abgelesen', 'Wasser abgelesen',
                      'Einbrüche L1', 'Einbrüche L2', 'Einbrüche L3',
                      'Überspannung L1', 'Überspannung L2', 'Überspannung L3', 'Stromausfälle'];
const KOPF_TAGE = ['Datum', 'Strom Bezug (kWh)', 'Strom Einspeisung (kWh)', 'Gas (m³)', 'Wasser (m³)'];

// Einmal manuell ausführen: setzt/aktualisiert die Kopfzeilen. Vorhandene Daten bleiben erhalten.
function einrichten() {
  const ss = SpreadsheetApp.getActive();
  [['Aktuell', KOPF_AKTUELL], ['Tage', KOPF_TAGE]].forEach(([name, kopf]) => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, kopf.length).setValues([kopf]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
}

function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  if (d.key !== WRITE_KEY) return antwort({ ok: false, fehler: 'key' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActive();
    const jetzt = new Date();
    const zahl = v => (v === undefined || v === null) ? '' : Number(v);

    // Gas und Wasser nur 1x pro Stunde schreiben (erste Meldung einer neuen Stunde), Strom alle 15 Min.
    const props = PropertiesService.getScriptProperties();
    const stunde = Utilities.formatDate(jetzt, TZ, 'yyyy-MM-dd HH');
    const gw = props.getProperty('gwStunde') !== stunde;
    if (gw) props.setProperty('gwStunde', stunde);
    const nurGW = v => gw ? v : '';

    ss.getSheetByName('Aktuell').appendRow([
      jetzt, zahl(d.strom_import_kwh), zahl(d.strom_export_kwh), zahl(d.leistung_w),
      zahl(d.l1_w), zahl(d.l2_w), zahl(d.l3_w), nurGW(zahl(d.gas_m3)), nurGW(zahl(d.wasser_m3)),
      zahl(d.l1_v), zahl(d.l2_v), zahl(d.l3_v), zahl(d.l1_a), zahl(d.l2_a), zahl(d.l3_a),
      nurGW(zeitstempel(d.gas_ts)), nurGW(zeitstempel(d.wasser_ts)),
      zahl(d.sag_l1), zahl(d.sag_l2), zahl(d.sag_l3),
      zahl(d.swell_l1), zahl(d.swell_l2), zahl(d.swell_l3), zahl(d.stromausfall)
    ]);

    // Tagesblatt: eine Zeile pro Tag mit dem jeweils letzten Zählerstand (Endstand)
    const tage = ss.getSheetByName('Tage');
    const datum = Utilities.formatDate(jetzt, TZ, 'yyyy-MM-dd');
    const zeile = [datum, zahl(d.strom_import_kwh), zahl(d.strom_export_kwh), zahl(d.gas_m3), zahl(d.wasser_m3)];
    const letzte = tage.getLastRow();
    const letztesDatum = letzte > 1 ? String(tage.getRange(letzte, 1).getDisplayValue()) : '';
    if (letztesDatum === datum) {
      if (!gw) {  // Gas/Wasser-Endstand des Tages nur stündlich aktualisieren
        const alt = tage.getRange(letzte, 4, 1, 2).getValues()[0];
        zeile[3] = alt[0]; zeile[4] = alt[1];
      }
      tage.getRange(letzte, 1, 1, zeile.length).setValues([zeile]);
    } else {
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
  const tageWerte = anzT ? tage.getRange(tage.getLastRow() - anzT + 1, 1, anzT, 5).getDisplayValues() : [];

  return antwort({
    ok: true,
    messungen: messungen.map(r => ({
      zeit: r[0] instanceof Date ? r[0].toISOString() : r[0],
      import: r[1], export: r[2], leistung: r[3], l1: r[4], l2: r[5], l3: r[6], gas: r[7], wasser: r[8],
      u1: r[9], u2: r[10], u3: r[11], i1: r[12], i2: r[13], i3: r[14],
      gasZeit: r[15] instanceof Date ? r[15].toISOString() : r[15],
      wasserZeit: r[16] instanceof Date ? r[16].toISOString() : r[16],
      sag1: r[17], sag2: r[18], sag3: r[19], swell1: r[20], swell2: r[21], swell3: r[22], ausfaelle: r[23]
    })),
    tage: tageWerte.map(r => ({
      datum: r[0],
      import: parseFloat(String(r[1]).replace(',', '.')),
      export: parseFloat(String(r[2]).replace(',', '.')),
      gas: parseFloat(String(r[3]).replace(',', '.')),
      wasser: parseFloat(String(r[4]).replace(',', '.'))
    }))
  });
}

// HomeWizard-Zeitstempel (JJMMTThhmmss, Ortszeit) in Datum umwandeln
function zeitstempel(v) {
  if (v === undefined || v === null || v === '') return '';
  const t = String(v).padStart(12, '0');
  return Utilities.parseDate(t, TZ, 'yyMMddHHmmss');
}

function antwort(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
