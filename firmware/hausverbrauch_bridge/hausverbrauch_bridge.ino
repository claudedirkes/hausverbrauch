// Hausverbrauch-Bridge: ESP32-CAM liest im festen 15-Min.-Raster (wie Leneda: :00/:15/:30/:45,
// jeweils 45 s danach, Uhrzeit per NTP) den HomeWizard P1 (lokale API)
// und schickt Strom, Gas und Wasser an das Google Apps Script "Hausverbrauch".
// WLAN wird beim ersten Start über das Setup-WLAN "Hausverbrauch-Setup" eingegeben (WiFiManager).
// Bibliotheken: ArduinoJson (v7), WiFiManager (tzapu).
// Update über WLAN: prüft beim Start und alle 24 h firmware/version.txt im Repo und installiert bei
// höherer Nummer firmware/hausverbrauch_ota.bin. Partitionsschema: "Minimal SPIFFS (… with OTA)".
// Leneda (ab v8): holt täglich je Tag Bezug, geteilten Strom (4 Ebenen) und Rest für den Lieferanten
// und schickt die Tagessummen ans Script. Zugang wird auf http://<IP>/leneda eingegeben (NVS).
// Script-URL und Key werden beim ersten Start im Flash (NVS) gespeichert; die OTA-Datei im
// öffentlichen Repo enthält deshalb nur Platzhalter.

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <WiFiManager.h>
#include <Preferences.h>
#include <HTTPUpdate.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include "icon_png.h"

// ---------- Einstellungen anpassen ----------
const char* HW_URL     = "http://192.168.178.79/api/v1/data";
const char* SCRIPT_URL = "https://script.google.com/macros/s/DEINE_ID/exec";
const char* WRITE_KEY  = "GLEICHER_KEY_WIE_IM_APPS_SCRIPT";
const long RASTER_S  = 15L * 60L;  // Raster 15 Minuten (wie Leneda)
const long VERSATZ_S = 45;         // 45 s nach dem Rasterpunkt abfragen: Gas/Wasser (alle 5 Min.) sind dann aktuell
const long NACHHOLEN_S = 5L * 60L; // fehlgeschlagene Abfrage bis 5 Min. nach dem Rasterpunkt wiederholen
const char* ZEITZONE = "CET-1CEST,M3.5.0,M10.5.0/3";  // Luxemburg inkl. Sommerzeit
// --------------------------------------------

const int FW_VERSION = 8;  // bei jeder neuen Firmware erhöhen (und version.txt im Repo anpassen)
const char* OTA_VERSION_URL = "https://raw.githubusercontent.com/claudedirkes/hausverbrauch/main/firmware/version.txt";
const char* OTA_BIN_URL     = "https://raw.githubusercontent.com/claudedirkes/hausverbrauch/main/firmware/hausverbrauch_ota.bin";
const unsigned long OTA_INTERVALL_MS = 24UL * 60UL * 60UL * 1000UL;  // 24 Stunden

String scriptUrl, writeKey;          // aktive Werte (aus Code oder NVS)
unsigned long letztesOta = 0;
unsigned long letzterVersandMs = 0;
WebServer server(80);   // Live-Anzeige: http://hausverbrauch.local bzw. IP der ESP32-CAM

// Live-Seite: holt jede Sekunde /live; nichts wird gespeichert
const char LIVE_HTML[] PROGMEM = R"HTML(<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Live-Leistung</title>
<link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-title" content="Live">
<style>:root{--bg:#f3f6f9;--card:#fff;--t:#1d2733;--m:#6b7785;--a:#e6a700;--g:#2e9d5b}
@media(prefers-color-scheme:dark){:root{--bg:#10161d;--card:#1a222c;--t:#e6edf3;--m:#8b97a5}}
body{margin:0;padding:16px;background:var(--bg);color:var(--t);font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.w{max-width:520px;margin:0 auto}.c{background:var(--card);border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.m{color:var(--m);font-size:14px}.big{font-size:52px;font-weight:700;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}td,th{padding:8px 4px;text-align:right}th:first-child,td:first-child{text-align:left}
button{background:none;border:1px solid rgba(128,128,128,.4);color:var(--t);border-radius:8px;padding:8px 12px;font-size:15px;cursor:pointer}
th{color:var(--m);font-weight:600;font-size:14px}tr+tr td{border-top:1px solid rgba(128,128,128,.2)}</style></head><body><div class="w">
<h2>&#9889; Live-Leistung</h2>
<div class="c"><div class="m">Aktuelle Leistung</div><div class="big" id="p">&ndash;</div><div class="m" id="s">verbinde &hellip;</div></div>
<div class="c"><table><tr><th>Phase</th><th>Leistung</th><th>Spannung</th><th>Strom</th></tr>
<tr><td>L1</td><td id="w1">&ndash;</td><td id="v1">&ndash;</td><td id="a1">&ndash;</td></tr>
<tr><td>L2</td><td id="w2">&ndash;</td><td id="v2">&ndash;</td><td id="a2">&ndash;</td></tr>
<tr><td>L3</td><td id="w3">&ndash;</td><td id="v3">&ndash;</td><td id="a3">&ndash;</td></tr></table></div>
<div class="c"><div class="m"><a href="/leneda" style="color:inherit">Leneda-Abruf</a></div></div>
<div class="c"><div class="m">Firmware <span id="fw">&ndash;</span> &middot; <span id="dg"></span></div><div style="margin-top:8px"><button id="upd" type="button">Update pr&uuml;fen</button></div><div class="m" id="us" style="margin-top:8px"></div></div></div>
<script>const $=i=>document.getElementById(i),f=(v,d)=>v==null?'&ndash;':Number(v).toLocaleString('de-DE',{minimumFractionDigits:d,maximumFractionDigits:d});
async function hol(){try{const r=await fetch('/live',{cache:'no-store'}),d=await r.json();
$('fw').textContent='v'+d.fw;
$('dg').textContent='WLAN '+d.rssi+' dBm · l\u00e4uft seit '+d.laufzeit+' min · letzter Versand '+(d.versand<0?'noch keiner':'vor '+d.versand+' min')+' (Script '+d.script+')';
if(!d.ok){$('s').textContent='HomeWizard-Fehler '+d.hw+(d.hwFehler?' ('+d.hwFehler+')':'');}else{
$('p').innerHTML=f(d.p,0)+' W';$('p').style.color='var(--a)';
for(const i of[1,2,3]){$('w'+i).innerHTML=f(d['w'+i],0)+' W';$('v'+i).innerHTML=f(d['v'+i],1)+' V';$('a'+i).innerHTML=f(d['a'+i],2)+' A';}
$('s').textContent='Stand '+new Date().toLocaleTimeString('de-DE');}}catch(e){$('s').textContent='ESP32-CAM nicht erreichbar';}
setTimeout(hol,1000);}hol();
$('upd').onclick=async()=>{$('upd').disabled=true;$('us').textContent='pr\u00fcfe \u2026';try{const r=await fetch('/update',{method:'POST'}),d=await r.json();$('us').textContent=d.update?('Update auf v'+d.verfuegbar+' wird installiert. Neustart in ca. 1 Minute, dann Seite neu laden.'):(d.verfuegbar>0?'Aktuell (v'+d.installiert+'), kein Update verf\u00fcgbar.':'GitHub nicht erreichbar.');}catch(e){$('us').textContent='Fehler: '+e;}$('upd').disabled=false;};</script></body></html>)HTML";

void seiteLive() { server.send_P(200, "text/html; charset=utf-8", LIVE_HTML); }

void seiteIcon() {
  server.sendHeader("Cache-Control", "max-age=86400");
  server.send_P(200, "image/png", (const char*)ICON_PNG, ICON_PNG_LEN);
}

// Diagnose (Anzeige auf der Live-Seite)
int    diagHwCode = 0;        // letzter HTTP-Code vom HomeWizard (negativ = Verbindungsfehler)
String diagHwFehler = "";
int    diagScriptCode = 0;    // letzter HTTP-Code vom Apps Script
String diagLetzterVersand = "noch keiner";

bool updateAnstehend = false;  // vom Knopf "Update prüfen" gesetzt, ausgeführt in loop()

int verfuegbareVersion();      // weiter unten definiert

// Knopf "Update prüfen": Version auf GitHub abfragen, Antwort senden, Installation danach in loop()
void seiteUpdate() {
  int neu = verfuegbareVersion();
  bool update = neu > FW_VERSION;
  if (update) updateAnstehend = true;
  server.send(200, "application/json",
    String("{\"ok\":true,\"installiert\":") + FW_VERSION + ",\"verfuegbar\":" + neu + ",\"update\":" + (update ? "true" : "false") + "}");
}

void datenLive() {
  JsonDocument out;
  out["fw"]      = FW_VERSION;
  out["rssi"]    = WiFi.RSSI();
  out["laufzeit"] = millis() / 60000;  // Minuten seit Start
  out["script"]  = diagScriptCode;
  out["versand"] = letzterVersandMs ? (long)((millis() - letzterVersandMs) / 60000) : -1;

  HTTPClient http;
  http.begin(HW_URL);
  http.setTimeout(5000);
  int code = http.GET();
  diagHwCode = code;
  diagHwFehler = code < 0 ? http.errorToString(code) : "";
  out["hw"] = code;
  out["hwFehler"] = diagHwFehler;
  if (code == 200) {
    JsonDocument hw;
    DeserializationError err = deserializeJson(hw, http.getString());
    if (err) {
      out["ok"] = false; out["hwFehler"] = String("JSON: ") + err.c_str();
    } else {
      out["ok"] = true;
      out["p"]  = hw["active_power_w"];
      out["w1"] = hw["active_power_l1_w"];   out["w2"] = hw["active_power_l2_w"];   out["w3"] = hw["active_power_l3_w"];
      out["v1"] = hw["active_voltage_l1_v"]; out["v2"] = hw["active_voltage_l2_v"]; out["v3"] = hw["active_voltage_l3_v"];
      out["a1"] = hw["active_current_l1_a"]; out["a2"] = hw["active_current_l2_a"]; out["a3"] = hw["active_current_l3_a"];
    }
  } else {
    out["ok"] = false;
  }
  http.end();
  String body;
  serializeJson(out, body);
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", body);
}

long letzterSlot = 0;          // zuletzt erfolgreich gesendeter Rasterpunkt (Unix-Zeit)
long versuchterSlot = 0;       // Rasterpunkt, für den gerade Versuche laufen
unsigned long letzterVersuchMs = 0;
int fehlerInFolge = 0;         // verpasste Rasterpunkte in Folge

void wlanVerbinden() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("WLAN verbinden");
  WiFi.mode(WIFI_STA);
  WiFi.begin();  // gespeicherte Zugangsdaten
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? " OK " + WiFi.localIP().toString() : " FEHLER");
}

// HomeWizard abfragen und Sendedaten als JSON-Text zurückgeben ("" bei Fehler)
String homewizardLesen(long slot) {
  HTTPClient http;
  http.begin(HW_URL);
  http.setTimeout(8000);
  int code = http.GET();
  diagHwCode = code;
  diagHwFehler = code < 0 ? http.errorToString(code) : "";
  if (code != 200) {
    Serial.printf("HomeWizard Fehler: %d\n", code);
    http.end();
    return "";
  }
  JsonDocument hw;
  DeserializationError err = deserializeJson(hw, http.getString());
  http.end();
  if (err) {
    Serial.println("HomeWizard JSON ungültig");
    return "";
  }

  JsonDocument out;
  out["key"]              = writeKey;
  out["fw"]               = FW_VERSION;
  out["slot"]             = slot;   // Rasterpunkt (Unix-Zeit, UTC), auf den sich die Zählerstände beziehen
  out["strom_import_kwh"] = hw["total_power_import_kwh"];
  out["leistung_w"]       = hw["active_power_w"];
  out["l1_w"]             = hw["active_power_l1_w"];
  out["l2_w"]             = hw["active_power_l2_w"];
  out["l3_w"]             = hw["active_power_l3_w"];
  out["l1_v"]             = hw["active_voltage_l1_v"];
  out["l2_v"]             = hw["active_voltage_l2_v"];
  out["l3_v"]             = hw["active_voltage_l3_v"];
  out["l1_a"]             = hw["active_current_l1_a"];
  out["l2_a"]             = hw["active_current_l2_a"];
  out["l3_a"]             = hw["active_current_l3_a"];
  out["sag_l1"]           = hw["voltage_sag_l1_count"];
  out["sag_l2"]           = hw["voltage_sag_l2_count"];
  out["sag_l3"]           = hw["voltage_sag_l3_count"];
  out["swell_l1"]         = hw["voltage_swell_l1_count"];
  out["swell_l2"]         = hw["voltage_swell_l2_count"];
  out["swell_l3"]         = hw["voltage_swell_l3_count"];
  out["stromausfall"]     = hw["any_power_fail_count"];
  out["gas_m3"]           = hw["total_gas_m3"];
  out["gas_ts"]           = hw["gas_timestamp"];   // Ablesezeit Gas, Format JJMMTThhmmss

  // Wasser steckt im Array "external" mit type = water_meter
  for (JsonObject ext : hw["external"].as<JsonArray>()) {
    if (ext["type"] == "water_meter") {
      out["wasser_m3"] = ext["value"];
      out["wasser_ts"] = ext["timestamp"];          // Ablesezeit Wasser, Format JJMMTThhmmss
      break;
    }
  }

  String body;
  serializeJson(out, body);
  return body;
}

bool anScriptSenden(const String& body) {
  WiFiClientSecure client;
  client.setInsecure();  // kein Zertifikats-Check (einfach, für diesen Zweck ausreichend)
  HTTPClient http;
  http.begin(client, scriptUrl);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  http.end();
  // Google antwortet nach erfolgreichem Schreiben mit 302 (Weiterleitung) – zählt als Erfolg
  Serial.printf("Apps Script Antwort: %d\n", code);
  diagScriptCode = code;
  return code == 200 || code == 302;
}

// Script-URL/Key: Werte aus dem Code haben Vorrang, wenn es keine Platzhalter sind; sonst NVS.
void zugangLaden() {
  Preferences p;
  p.begin("hv", false);
  bool codeEcht = String(SCRIPT_URL).indexOf("DEINE_ID") < 0 && String(WRITE_KEY).indexOf("GLEICHER_KEY") < 0;
  if (codeEcht) {
    scriptUrl = SCRIPT_URL; writeKey = WRITE_KEY;
    p.putString("url", scriptUrl); p.putString("key", writeKey);
  } else {
    scriptUrl = p.getString("url", ""); writeKey = p.getString("key", "");
  }
  p.end();
  Serial.println(scriptUrl.isEmpty() ? "Keine Script-URL gespeichert!" : "Script-URL geladen");
}

// Neue Firmware auf GitHub? Dann installieren und neu starten.
// Versionsnummer aus version.txt auf GitHub (0 bei Fehler); ?t= umgeht den Cache
int verfuegbareVersion() {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, String(OTA_VERSION_URL) + "?t=" + millis());
  http.setTimeout(10000);
  int code = http.GET();
  int neu = (code == 200) ? http.getString().toInt() : 0;
  http.end();
  Serial.printf("OTA: installiert %d, verfügbar %d (HTTP %d)\n", FW_VERSION, neu, code);
  return neu;
}

void otaInstallieren() {
  WiFiClientSecure binClient;
  binClient.setInsecure();
  httpUpdate.rebootOnUpdate(true);
  t_httpUpdate_return r = httpUpdate.update(binClient, String(OTA_BIN_URL) + "?t=" + millis());
  if (r == HTTP_UPDATE_FAILED) {
    Serial.printf("OTA Fehler: %s\n", httpUpdate.getLastErrorString().c_str());
  }
}

// Neue Firmware auf GitHub? Dann installieren und neu starten.
void otaPruefen() {
  if (verfuegbareVersion() > FW_VERSION) otaInstallieren();
}

// Ein Versuch für den Rasterpunkt slot. true = gesendet.
bool ablesen(long slot) {
  wlanVerbinden();
  if (WiFi.status() != WL_CONNECTED) return false;
  String body = homewizardLesen(slot);
  if (body.isEmpty() || !anScriptSenden(body)) return false;
  diagLetzterVersand = "vor 0 min";
  letzterVersandMs = millis();
  Serial.println("Gesendet: " + body);
  return true;
}

bool zeitOk() { return time(nullptr) > 1700000000; }  // NTP-Zeit vorhanden?

// Im Raster :00/:15/:30/:45 (+45 s) abfragen; bei Fehler jede Minute neu versuchen, max. 5 Min. lang
void rasterPruefen() {
  if (!zeitOk()) return;
  long jetzt = (long)time(nullptr);
  long slot = jetzt - (jetzt % RASTER_S);   // letzter Rasterpunkt (UTC-Raster = Ortszeit-Raster)
  long seit = jetzt - slot;
  if (slot == letzterSlot || seit < VERSATZ_S) return;
  if (seit > NACHHOLEN_S) {                 // Fenster verpasst
    if (versuchterSlot == slot) {
      versuchterSlot = 0;
      fehlerInFolge++;
      Serial.printf("Rasterpunkt verpasst (%d in Folge)\n", fehlerInFolge);
      if (fehlerInFolge >= 8) {             // 2 Stunden ohne Erfolg -> Neustart
        Serial.println("Zu viele Fehler, Neustart");
        delay(1000);
        ESP.restart();
      }
    }
    return;
  }
  if (versuchterSlot == slot && millis() - letzterVersuchMs < 60000) return;
  versuchterSlot = slot;
  letzterVersuchMs = millis();
  if (ablesen(slot)) {
    letzterSlot = slot;
    versuchterSlot = 0;
    fehlerInFolge = 0;
  }
}


// ==================== Leneda (Energiegemeinschaft) ====================
// Je Tag (Ortszeit) werden 6 Reihen geholt und summiert: Bezug, geteilt Ebene 1-4, Rest für den Lieferanten.
// Fortschritt: lenAb = nächster abzurufender Tag. Täglich ab 7 Uhr werden die letzten 7 Tage neu geholt,
// weil Leneda verzögert liefert. Nie in den ersten 6 Minuten nach einem Rasterpunkt (dann läuft die Messung).
const char* LENEDA_URL = "https://api.leneda.lu/api/metering-points/";
const char* LENEDA_OBIS[6] = { "1-1:1.29.0", "1-65:1.29.1", "1-65:1.29.3", "1-65:1.29.2", "1-65:1.29.4", "1-65:1.29.9" };
const char* LENEDA_FELD[6] = { "bezug", "l1", "l2", "l3", "l4", "rest" };

String lenKey, lenId, lenPod, lenAb, lenZurueck, lenStatus = "nicht eingerichtet", lenLetzter = "-";
unsigned long lenNaechsterMs = 0;

void lenedaLaden() {
  Preferences p; p.begin("leneda", true);
  lenKey = p.getString("key", ""); lenId = p.getString("id", ""); lenPod = p.getString("pod", "");
  lenAb = p.getString("ab", ""); lenZurueck = p.getString("zur", ""); lenLetzter = p.getString("letzter", "-");
  p.end();
  if (lenKey.length() && lenId.length() && lenPod.length() && lenAb.length()) lenStatus = "bereit";
}
void lenedaMerken(const char* k, const String& v) { Preferences p; p.begin("leneda", false); p.putString(k, v); p.end(); }

// "JJJJ-MM-TT" <-> Zeit (Ortszeit, Mitternacht bzw. Mittag)
time_t tagZeit(const String& d, int stunde) {
  struct tm t = {}; t.tm_year = d.substring(0, 4).toInt() - 1900; t.tm_mon = d.substring(5, 7).toInt() - 1;
  t.tm_mday = d.substring(8, 10).toInt(); t.tm_hour = stunde; t.tm_isdst = -1;
  return mktime(&t);
}
String tagText(time_t z) { struct tm t; localtime_r(&z, &t); char b[11]; strftime(b, sizeof b, "%Y-%m-%d", &t); return b; }
String tagPlus(const String& d, int n) { return tagText(tagZeit(d, 12) + (time_t)n * 86400); }
String utcText(time_t z) { struct tm t; gmtime_r(&z, &t); char b[21]; strftime(b, sizeof b, "%Y-%m-%dT%H:%M:%SZ", &t); return b; }

// Eine Reihe für einen Tag holen. Rückgabe: HTTP-Code; summe in kWh, anzahl = Werte
int lenedaReihe(const char* obis, const String& von, const String& bis, double& summe, int& anzahl) {
  WiFiClientSecure client; client.setInsecure();
  HTTPClient http;
  String url = String(LENEDA_URL) + lenPod + "/time-series?obisCode=" + obis + "&startDateTime=" + von + "&endDateTime=" + bis;
  http.begin(client, url);
  http.setTimeout(20000);
  http.addHeader("X-API-KEY", lenKey);
  http.addHeader("X-ENERGY-ID", lenId);
  int code = http.GET();
  summe = 0; anzahl = 0;
  if (code == 200) {
    JsonDocument filter;
    filter["unit"] = true; filter["intervalLength"] = true; filter["items"][0]["value"] = true;
    JsonDocument j;
    DeserializationError err = deserializeJson(j, http.getString(), DeserializationOption::Filter(filter));
    if (err) code = -100;
    else {
      String iv = j["intervalLength"] | "PT15M";
      double h = iv == "PT1H" ? 1.0 : iv == "PT30M" ? 0.5 : 0.25;
      bool kw = String(j["unit"] | "") == "kW";
      for (JsonObject it : j["items"].as<JsonArray>()) { summe += (double)(it["value"] | 0.0) * (kw ? h : 1.0); anzahl++; }
    }
  }
  http.end();
  return code;
}

// Einen Tag abrufen und senden. Rückgabe: 1 = gesendet, 0 = Leneda hat noch keine Daten, -1 = Fehler
int lenedaTag(const String& tag) {
  String von = utcText(tagZeit(tag, 0)), bis = utcText(tagZeit(tagPlus(tag, 1), 0));
  JsonDocument out;
  out["key"] = writeKey; out["aktion"] = "leneda"; out["datum"] = tag;
  int nGeteilt = 0;
  for (int i = 0; i < 6; i++) {
    double summe; int anzahl;
    int code = lenedaReihe(LENEDA_OBIS[i], von, bis, summe, anzahl);
    if (code != 200) { lenStatus = String("Fehler ") + code + " bei " + LENEDA_OBIS[i] + " (" + tag + ")"; return -1; }
    if (i == 0 && anzahl == 0) return 0;
    out[LENEDA_FELD[i]] = round(summe * 1000) / 1000.0;
    if (i == 0) out["nBezug"] = anzahl; else if (i == 5) out["nRest"] = anzahl; else nGeteilt += anzahl;
  }
  out["nGeteilt"] = nGeteilt;
  String body; serializeJson(out, body);
  if (!anScriptSenden(body)) { lenStatus = "Script nicht erreichbar (" + tag + ")"; return -1; }
  return 1;
}

void lenedaPruefen() {
  if (!zeitOk() || lenStatus == "nicht eingerichtet" || millis() < lenNaechsterMs) return;
  long jetzt = (long)time(nullptr);
  if (jetzt % RASTER_S < 6 * 60) return;              // Messung hat Vorrang
  String heute = tagText(jetzt);
  struct tm t; time_t z = jetzt; localtime_r(&z, &t);
  if (t.tm_hour >= 7 && lenZurueck != heute) {          // täglich: letzte 7 Tage neu holen
    String ab = tagPlus(heute, -7);
    if (lenAb > ab) { lenAb = ab; lenedaMerken("ab", lenAb); }
    lenZurueck = heute; lenedaMerken("zur", lenZurueck);
  }
  if (lenAb >= heute) return;
  wlanVerbinden();
  if (WiFi.status() != WL_CONNECTED) { lenNaechsterMs = millis() + 60000; return; }
  int r = lenedaTag(lenAb);
  if (r == 1) {
    lenLetzter = lenAb; lenedaMerken("letzter", lenLetzter);
    lenStatus = "OK, zuletzt " + lenAb;
    lenAb = tagPlus(lenAb, 1); lenedaMerken("ab", lenAb);
    lenNaechsterMs = millis() + 5000;
  } else if (r == 0) {
    if (lenAb < tagPlus(heute, -10)) { lenAb = tagPlus(lenAb, 1); lenedaMerken("ab", lenAb); lenNaechsterMs = millis() + 5000; }
    else { lenStatus = "wartet auf Leneda ab " + lenAb; lenAb = heute; lenedaMerken("ab", lenAb); }  // morgen ab 7 Uhr erneut
  } else {
    lenNaechsterMs = millis() + 5UL * 60000;              // Fehler: in 5 Min. erneut
  }
  Serial.println("Leneda: " + lenStatus);
}

// Einstellungsseite http://<IP>/leneda (der API-Key wird nie angezeigt)
void seiteLeneda() {
  if (server.method() == HTTP_POST) {
    if (server.arg("id").length())  { lenId = server.arg("id");   lenedaMerken("id", lenId); }
    if (server.arg("pod").length()) { lenPod = server.arg("pod"); lenedaMerken("pod", lenPod); }
    if (server.arg("key").length()) { lenKey = server.arg("key"); lenedaMerken("key", lenKey); }
    if (server.arg("ab").length() == 10) { lenAb = server.arg("ab"); lenedaMerken("ab", lenAb); }
    lenStatus = (lenKey.length() && lenId.length() && lenPod.length() && lenAb.length()) ? "bereit" : "nicht eingerichtet";
    lenNaechsterMs = 0;
    server.sendHeader("Location", "/leneda"); server.send(303); return;
  }
  String h = F("<!DOCTYPE html><html lang=\"de\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
    "<title>Leneda</title><style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;padding:16px;background:#f3f6f9;color:#1d2733}"
    "@media(prefers-color-scheme:dark){body{background:#10161d;color:#e6edf3}input{background:#1a222c;color:#e6edf3}}"
    "label{display:block;margin:10px 0 4px;font-size:14px}input{width:100%;box-sizing:border-box;font-size:16px;padding:8px;border:1px solid #8888;border-radius:8px}"
    "button{margin-top:14px;font-size:16px;padding:10px 16px;border-radius:8px;border:0;background:#e6a700;color:#1d2733;font-weight:600}"
    ".m{color:#8b97a5;font-size:14px}</style></head><body><h2>Leneda-Abruf</h2>");
  h += "<p class=\"m\">Status: " + lenStatus + "<br>Zuletzt gesendet: " + lenLetzter + "<br>Nächster Tag: " + (lenAb.length() ? lenAb : "-") + "</p>";
  h += "<form method=\"post\"><label>Energy-ID</label><input name=\"id\" value=\"" + lenId + "\">";
  h += "<label>Zählpunkt Strom (POD)</label><input name=\"pod\" value=\"" + lenPod + "\">";
  h += String("<label>API-Key ") + (lenKey.length() ? "(gespeichert, leer lassen = behalten)" : "") + "</label><input name=\"key\" type=\"password\" autocomplete=\"off\">";
  h += "<label>Abrufen ab (JJJJ-MM-TT, setzt den Fortschritt zurück)</label><input name=\"ab\" type=\"date\">";
  h += F("<button>Speichern</button></form><p class=\"m\"><a href=\"/\" style=\"color:inherit\">zurück</a></p></body></html>");
  server.send(200, "text/html; charset=utf-8", h);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\nHausverbrauch-Bridge startet");
  // Ohne gespeichertes/erreichbares WLAN: Setup-WLAN "Hausverbrauch-Setup" für 5 Min. öffnen
  WiFiManager wm;
  wm.setConfigPortalTimeout(300);
  if (!wm.autoConnect("Hausverbrauch-Setup")) {
    Serial.println("Kein WLAN eingerichtet, Neustart");
    delay(1000);
    ESP.restart();
  }
  Serial.println("WLAN OK " + WiFi.localIP().toString());
  Serial.printf("Firmware-Version %d\n", FW_VERSION);
  configTzTime(ZEITZONE, "pool.ntp.org", "time.google.com");
  for (int i = 0; i < 20 && !zeitOk(); i++) delay(500);
  Serial.println(zeitOk() ? "Uhrzeit OK" : "Uhrzeit noch nicht da, wird nachgeholt");
  zugangLaden();
  lenedaLaden();
  otaPruefen();
  letztesOta = millis();

  if (MDNS.begin("hausverbrauch")) MDNS.addService("http", "tcp", 80);
  server.on("/", seiteLive);
  server.on("/live", datenLive);
  server.on("/apple-touch-icon.png", seiteIcon);
  server.on("/update", HTTP_POST, seiteUpdate);
  server.on("/leneda", seiteLeneda);
  server.begin();
  Serial.println("Live-Anzeige: http://hausverbrauch.local bzw. http://" + WiFi.localIP().toString());
}

void loop() {
  rasterPruefen();
  lenedaPruefen();
  if (millis() - letztesOta >= OTA_INTERVALL_MS) {
    letztesOta = millis();
    wlanVerbinden();
    if (WiFi.status() == WL_CONNECTED) otaPruefen();
  }
  server.handleClient();
  if (updateAnstehend) {
    updateAnstehend = false;
    delay(500);  // Antwort an den Browser fertig senden
    otaInstallieren();
  }
  delay(5);
}
