// Google Apps Script "Hausverbrauch" – im Sheet unter Erweiterungen > Apps Script einfügen.
// doPost: nimmt Werte der ESP32-Bridge entgegen. doGet: liefert JSON für die WebApp.

const WRITE_KEY = 'HIER_EIGENEN_KEY_EINTRAGEN';   // gleicher Wert wie WRITE_KEY in der Firmware
const TZ = 'Europe/Luxembourg';
const KOPF_AKTUELL = ['Empfangen', 'Strom Bezug (kWh)', 'Strom Einspeisung (kWh)', 'Leistung (W)',
                      'L1 (W)', 'L2 (W)', 'L3 (W)', 'Gas (m³)', 'Wasser (m³)'];
const KOPF_TAGE = ['Datum', 'Strom Bezug (kWh)', 'Strom Einspeisung (kWh)', 'Gas (m³)', 'Wasser (m³)'];

// Einmal manuell ausführen: setzt die Kopfzeilen (löscht vorhandene Inhalte der beiden Blätter!)
function einrichten() {
  const ss = SpreadsheetApp.getActive();
  [['Aktuell', KOPF_AKTUELL], ['Tage', KOPF_TAGE]].forEach(([name, kopf]) => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.clear();
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

    ss.getSheetByName('Aktuell').appendRow([
      jetzt, zahl(d.strom_import_kwh), zahl(d.strom_export_kwh), zahl(d.leistung_w),
      zahl(d.l1_w), zahl(d.l2_w), zahl(d.l3_w), zahl(d.gas_m3), zahl(d.wasser_m3)
    ]);

    // Tagesblatt: eine Zeile pro Tag mit dem jeweils letzten Zählerstand (Endstand)
    const tage = ss.getSheetByName('Tage');
    const datum = Utilities.formatDate(jetzt, TZ, 'yyyy-MM-dd');
    const zeile = [datum, zahl(d.strom_import_kwh), zahl(d.strom_export_kwh), zahl(d.gas_m3), zahl(d.wasser_m3)];
    const letzte = tage.getLastRow();
    const letztesDatum = letzte > 1 ? String(tage.getRange(letzte, 1).getDisplayValue()) : '';
    if (letztesDatum === datum) {
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
  const messungen = anzA ? akt.getRange(akt.getLastRow() - anzA + 1, 1, anzA, 9).getValues() : [];

  // bis zu 400 Tage
  const nT = Math.max(0, tage.getLastRow() - 1);
  const anzT = Math.min(nT, 400);
  const tageWerte = anzT ? tage.getRange(tage.getLastRow() - anzT + 1, 1, anzT, 5).getDisplayValues() : [];

  return antwort({
    ok: true,
    messungen: messungen.map(r => ({
      zeit: r[0] instanceof Date ? r[0].toISOString() : r[0],
      import: r[1], export: r[2], leistung: r[3], l1: r[4], l2: r[5], l3: r[6], gas: r[7], wasser: r[8]
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

function antwort(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
