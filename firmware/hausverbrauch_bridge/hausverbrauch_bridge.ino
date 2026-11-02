// Hausverbrauch-Bridge: ESP32-CAM liest alle 15 Min. den HomeWizard P1 (lokale API)
// und schickt Strom, Gas und Wasser an das Google Apps Script "Hausverbrauch".
// WLAN wird beim ersten Start über das Setup-WLAN "Hausverbrauch-Setup" eingegeben (WiFiManager).
// Bibliotheken: ArduinoJson (v7), WiFiManager (tzapu).
// Update über WLAN: prüft beim Start und alle 24 h firmware/version.txt im Repo und installiert bei
// höherer Nummer firmware/hausverbrauch_ota.bin. Partitionsschema: "Minimal SPIFFS (… with OTA)".
// Script-URL und Key werden beim ersten Start im Flash (NVS) gespeichert; die OTA-Datei im
// öffentlichen Repo enthält deshalb nur Platzhalter.

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <WiFiManager.h>
#include <Preferences.h>
#include <HTTPUpdate.h>

// ---------- Einstellungen anpassen ----------
const char* HW_URL     = "http://192.168.178.79/api/v1/data";
const char* SCRIPT_URL = "https://script.google.com/macros/s/DEINE_ID/exec";
const char* WRITE_KEY  = "GLEICHER_KEY_WIE_IM_APPS_SCRIPT";
const unsigned long INTERVALL_MS = 15UL * 60UL * 1000UL;  // 15 Minuten
// --------------------------------------------

const int FW_VERSION = 2;  // bei jeder neuen Firmware erhöhen (und version.txt im Repo anpassen)
const char* OTA_VERSION_URL = "https://raw.githubusercontent.com/claudedirkes/hausverbrauch/main/firmware/version.txt";
const char* OTA_BIN_URL     = "https://raw.githubusercontent.com/claudedirkes/hausverbrauch/main/firmware/hausverbrauch_ota.bin";
const unsigned long OTA_INTERVALL_MS = 24UL * 60UL * 60UL * 1000UL;  // 24 Stunden

String scriptUrl, writeKey;          // aktive Werte (aus Code oder NVS)
unsigned long letztesOta = 0;

unsigned long letzterLauf = 0;
bool ersterLauf = true;
int fehlerInFolge = 0;

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
String homewizardLesen() {
  HTTPClient http;
  http.begin(HW_URL);
  http.setTimeout(8000);
  int code = http.GET();
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
  out["strom_import_kwh"] = hw["total_power_import_kwh"];
  out["strom_export_kwh"] = hw["total_power_export_kwh"];
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
void otaPruefen() {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.begin(client, OTA_VERSION_URL);
  http.setTimeout(10000);
  int code = http.GET();
  int neu = (code == 200) ? http.getString().toInt() : 0;
  http.end();
  Serial.printf("OTA: installiert %d, verfügbar %d (HTTP %d)\n", FW_VERSION, neu, code);
  if (neu <= FW_VERSION) return;

  WiFiClientSecure binClient;
  binClient.setInsecure();
  httpUpdate.rebootOnUpdate(true);
  t_httpUpdate_return r = httpUpdate.update(binClient, OTA_BIN_URL);
  if (r == HTTP_UPDATE_FAILED) {
    Serial.printf("OTA Fehler: %s\n", httpUpdate.getLastErrorString().c_str());
  }
}

void ablesen() {
  wlanVerbinden();
  if (WiFi.status() != WL_CONNECTED) { fehlerInFolge++; return; }

  String body = homewizardLesen();
  if (body.isEmpty() || !anScriptSenden(body)) {
    fehlerInFolge++;
  } else {
    fehlerInFolge = 0;
    Serial.println("Gesendet: " + body);
  }

  if (fehlerInFolge >= 8) {  // ca. 2 Stunden ohne Erfolg -> Neustart
    Serial.println("Zu viele Fehler, Neustart");
    delay(1000);
    ESP.restart();
  }
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
  zugangLaden();
  otaPruefen();
  letztesOta = millis();
}

void loop() {
  if (ersterLauf || millis() - letzterLauf >= INTERVALL_MS) {
    ersterLauf = false;
    letzterLauf = millis();
    ablesen();
  }
  if (millis() - letztesOta >= OTA_INTERVALL_MS) {
    letztesOta = millis();
    wlanVerbinden();
    if (WiFi.status() == WL_CONNECTED) otaPruefen();
  }
  delay(1000);
}
