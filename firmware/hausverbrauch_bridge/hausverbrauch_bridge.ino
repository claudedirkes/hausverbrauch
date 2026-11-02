// Hausverbrauch-Bridge: ESP32-CAM liest alle 15 Min. den HomeWizard P1 (lokale API)
// und schickt Strom, Gas und Wasser an das Google Apps Script "Hausverbrauch".
// WLAN wird beim ersten Start über das Setup-WLAN "Hausverbrauch-Setup" eingegeben (WiFiManager).
// Bibliotheken: ArduinoJson (v7), WiFiManager (tzapu).

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <WiFiManager.h>

// ---------- Einstellungen anpassen ----------
const char* HW_URL     = "http://192.168.178.79/api/v1/data";
const char* SCRIPT_URL = "https://script.google.com/macros/s/DEINE_ID/exec";
const char* WRITE_KEY  = "GLEICHER_KEY_WIE_IM_APPS_SCRIPT";
const unsigned long INTERVALL_MS = 15UL * 60UL * 1000UL;  // 15 Minuten
// --------------------------------------------

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
  out["key"]              = WRITE_KEY;
  out["strom_import_kwh"] = hw["total_power_import_kwh"];
  out["strom_export_kwh"] = hw["total_power_export_kwh"];
  out["leistung_w"]       = hw["active_power_w"];
  out["l1_w"]             = hw["active_power_l1_w"];
  out["l2_w"]             = hw["active_power_l2_w"];
  out["l3_w"]             = hw["active_power_l3_w"];
  out["gas_m3"]           = hw["total_gas_m3"];

  // Wasser steckt im Array "external" mit type = water_meter
  for (JsonObject ext : hw["external"].as<JsonArray>()) {
    if (ext["type"] == "water_meter") {
      out["wasser_m3"] = ext["value"];
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
  http.begin(client, SCRIPT_URL);
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  http.end();
  // Google antwortet nach erfolgreichem Schreiben mit 302 (Weiterleitung) – zählt als Erfolg
  Serial.printf("Apps Script Antwort: %d\n", code);
  return code == 200 || code == 302;
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
}

void loop() {
  if (ersterLauf || millis() - letzterLauf >= INTERVALL_MS) {
    ersterLauf = false;
    letzterLauf = millis();
    ablesen();
  }
  delay(1000);
}
