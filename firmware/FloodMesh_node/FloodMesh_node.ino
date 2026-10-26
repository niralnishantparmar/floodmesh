#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include "driver/gpio.h"

const char *SUPABASE_URL = "https://nqwgfnpksaqsvyzitwax.supabase.co";
const char *SUPABASE_KEY = "sb_publishable_eI3c2zcEgRGGSH2K75bmZw_GYwGLi2l";
const char *FIRMWARE = "1.1";
const uint32_t POST_EVERY_MS = 10000;
const uint32_t REGISTER_EVERY_MS = 15000;
const uint32_t WIFI_GIVE_UP_MS = 120000;
const int RISE_WINDOW_S = 60;
const bool BATTERY_WIRED = false;
const int BATTERY_PIN = 1;
const int BOOT_PIN = 0;

const gpio_num_t DS18B20_PIN = GPIO_NUM_4;
const int ULTRA_RX_PIN = 18;
const int ULTRA_TX_PIN = 17;

HardwareSerial UltraSerial(1);
Preferences prefs;
WebServer server(80);
DNSServer dns;

String wifiSsid;
String wifiPass;
String deviceKey;
String pairingCode;
String scanOptions;
String setupState = "idle";
bool setupMode = false;
bool paired = false;
uint32_t connectStartedMs = 0;
uint32_t pairedAtMs = 0;
uint32_t lastRegisterMs = 0;
uint32_t lastPostMs = 0;
uint32_t lastWifiAttemptMs = 0;
uint32_t lastCodePrintMs = 0;
uint32_t bootPressedMs = 0;
uint32_t wifiLostSinceMs = 0;

static portMUX_TYPE owMux = portMUX_INITIALIZER_UNLOCKED;

static inline void owLow() { gpio_set_level(DS18B20_PIN, 0); }
static inline void owRelease() { gpio_set_level(DS18B20_PIN, 1); }
static inline int owRead() { return gpio_get_level(DS18B20_PIN); }

bool owReset() {
  portENTER_CRITICAL(&owMux);
  owLow();
  delayMicroseconds(480);
  owRelease();
  delayMicroseconds(70);
  bool presence = (owRead() == 0);
  portEXIT_CRITICAL(&owMux);
  delayMicroseconds(410);
  bool lineHigh = (owRead() == 1);
  return presence && lineHigh;
}

void owWriteBit(bool bit) {
  portENTER_CRITICAL(&owMux);
  owLow();
  if (bit) { delayMicroseconds(6); owRelease(); delayMicroseconds(64); }
  else { delayMicroseconds(60); owRelease(); delayMicroseconds(10); }
  portEXIT_CRITICAL(&owMux);
}

bool owReadBit() {
  portENTER_CRITICAL(&owMux);
  owLow();
  delayMicroseconds(3);
  owRelease();
  delayMicroseconds(10);
  bool bit = owRead();
  portEXIT_CRITICAL(&owMux);
  delayMicroseconds(53);
  return bit;
}

void owWriteByte(uint8_t v) {
  for (int i = 0; i < 8; i++) { owWriteBit(v & 0x01); v >>= 1; }
}

uint8_t owReadByte() {
  uint8_t v = 0;
  for (int i = 0; i < 8; i++) { if (owReadBit()) v |= (1 << i); }
  return v;
}

uint8_t crc8(const uint8_t *data, int len) {
  uint8_t crc = 0;
  for (int i = 0; i < len; i++) {
    uint8_t b = data[i];
    for (int j = 0; j < 8; j++) {
      uint8_t mix = (crc ^ b) & 0x01;
      crc >>= 1;
      if (mix) crc ^= 0x8C;
      b >>= 1;
    }
  }
  return crc;
}

float lastTempC = NAN;
bool dsConverting = false;
uint32_t dsStartMs = 0;
uint32_t dsNextTryMs = 0;

void serviceTemperature() {
  uint32_t now = millis();
  if (!dsConverting) {
    if ((int32_t)(now - dsNextTryMs) < 0) return;
    if (!owReset()) { lastTempC = NAN; dsNextTryMs = now + 1000; return; }
    owWriteByte(0xCC);
    owWriteByte(0x44);
    dsConverting = true;
    dsStartMs = now;
  } else if (now - dsStartMs >= 800) {
    dsConverting = false;
    dsNextTryMs = now + 2000;
    if (!owReset()) { lastTempC = NAN; return; }
    owWriteByte(0xCC);
    owWriteByte(0xBE);
    uint8_t d[9];
    bool allZero = true;
    for (int i = 0; i < 9; i++) { d[i] = owReadByte(); if (d[i]) allZero = false; }
    if (allZero || crc8(d, 8) != d[8]) { lastTempC = NAN; return; }
    int16_t raw = (int16_t)(((uint16_t)d[1] << 8) | d[0]);
    float t = raw / 16.0f;
    lastTempC = (t == 85.0f) ? NAN : t;
  }
}

const int FRAME_BUF = 9;
int frames[FRAME_BUF];
int frameCount = 0;
int frameIdx = 0;
uint32_t lastFrameMs = 0;
uint8_t win[4] = {0, 0, 0, 0};
uint32_t lastTriggerMs = 0;

void onFrame(int mm) {
  if (mm < 30 || mm > 4500) return;
  frames[frameIdx] = mm;
  frameIdx = (frameIdx + 1) % FRAME_BUF;
  if (frameCount < FRAME_BUF) frameCount++;
  lastFrameMs = millis();
}

void serviceUltrasonic() {
  uint32_t now = millis();
  if (now - lastTriggerMs >= 150) {
    lastTriggerMs = now;
    UltraSerial.write(0x55);
  }
  while (UltraSerial.available() > 0) {
    uint8_t b = (uint8_t)UltraSerial.read();
    win[0] = win[1]; win[1] = win[2]; win[2] = win[3]; win[3] = b;
    if (win[0] == 0xFF && (uint8_t)(win[0] + win[1] + win[2]) == win[3]) {
      onFrame(((int)win[1] << 8) | win[2]);
      win[0] = win[1] = win[2] = win[3] = 0;
    }
  }
}

int medianOf(const int *values, int n) {
  int tmp[16];
  if (n > 16) n = 16;
  for (int i = 0; i < n; i++) tmp[i] = values[i];
  for (int i = 1; i < n; i++) {
    int v = tmp[i];
    int j = i - 1;
    while (j >= 0 && tmp[j] > v) { tmp[j + 1] = tmp[j]; j--; }
    tmp[j + 1] = v;
  }
  return tmp[n / 2];
}

const int HIST = 120;
uint32_t histMs[HIST];
int histMm[HIST];
int histCount = 0;
int histIdx = 0;
uint32_t lastSampleMs = 0;

void sampleOncePerSecond() {
  uint32_t now = millis();
  if (now - lastSampleMs < 1000) return;
  lastSampleMs = now;
  if (frameCount < 3 || now - lastFrameMs > 2000) return;
  histMs[histIdx] = now;
  histMm[histIdx] = medianOf(frames, frameCount);
  histIdx = (histIdx + 1) % HIST;
  if (histCount < HIST) histCount++;
}

int filteredDistance() {
  if (histCount == 0) return -1;
  int newest = (histIdx - 1 + HIST) % HIST;
  if (millis() - histMs[newest] > 5000) return -1;
  int n = histCount < 5 ? histCount : 5;
  int vals[5];
  for (int i = 0; i < n; i++) vals[i] = histMm[(histIdx - 1 - i + HIST) % HIST];
  return medianOf(vals, n);
}

float riseRateCmPerMin() {
  if (histCount < 10) return NAN;
  int newest = (histIdx - 1 + HIST) % HIST;
  uint32_t tNewest = histMs[newest];
  double sx = 0, sy = 0, sxx = 0, sxy = 0;
  int n = 0;
  for (int i = 0; i < histCount; i++) {
    int k = (histIdx - 1 - i + HIST) % HIST;
    double x = ((double)histMs[k] - (double)tNewest) / 1000.0;
    if (x < -RISE_WINDOW_S) break;
    double y = histMm[k];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
    n++;
  }
  if (n < 10) return NAN;
  double denom = n * sxx - sx * sx;
  if (denom == 0) return NAN;
  double slopeMmPerS = (n * sxy - sx * sy) / denom;
  return (float)(-slopeMmPerS * 6.0);
}

void readBattery(float &volts, float &pct) {
  volts = NAN;
  pct = NAN;
  if (!BATTERY_WIRED) return;
  uint32_t sum = 0;
  for (int i = 0; i < 8; i++) sum += analogReadMilliVolts(BATTERY_PIN);
  volts = (sum / 8.0f) * 2.0f / 1000.0f;
  pct = (volts - 3.30f) / (4.20f - 3.30f) * 100.0f;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
}

String randomHex(int bytes) {
  String out;
  for (int i = 0; i < bytes; i++) {
    char b[3];
    snprintf(b, sizeof b, "%02x", (unsigned)(esp_random() & 0xFF));
    out += b;
  }
  return out;
}

String randomCode() {
  const char *alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  String out;
  for (int i = 0; i < 6; i++) out += alphabet[esp_random() % 31];
  return out;
}

String prettyCode() {
  return pairingCode.substring(0, 3) + "-" + pairingCode.substring(3);
}

String htmlEscape(const String &in) {
  String out;
  for (unsigned int i = 0; i < in.length(); i++) {
    char c = in[i];
    if (c == '&') out += "&amp;";
    else if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '"') out += "&quot;";
    else out += c;
  }
  return out;
}

String jsonEscape(const String &in) {
  String out;
  for (unsigned int i = 0; i < in.length(); i++) {
    char c = in[i];
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if ((unsigned char)c < 0x20) out += ' ';
    else out += c;
  }
  return out;
}

void loadIdentity() {
  prefs.begin("floodmesh", false);
  deviceKey = prefs.getString("key", "");
  if (deviceKey.length() < 32) {
    deviceKey = randomHex(16);
    prefs.putString("key", deviceKey);
  }
  pairingCode = prefs.getString("code", "");
  if (pairingCode.length() != 6) {
    pairingCode = randomCode();
    prefs.putString("code", pairingCode);
  }
  wifiSsid = prefs.getString("ssid", "");
  wifiPass = prefs.getString("pass", "");
}

int rpcPost(const char *fn, const String &body, String &response) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/rpc/" + fn;
  if (!http.begin(client, url)) return -1;
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_KEY);
  int code = http.POST(body);
  response = (code > 0 && code != 204) ? http.getString() : String("");
  http.end();
  return code;
}

void registerDevice() {
  lastRegisterMs = millis();
  String body = String("{\"p_device_key\":\"") + deviceKey + "\",\"p_pairing_code\":\"" + pairingCode
    + "\",\"p_firmware\":\"" + FIRMWARE + "\"}";
  String response;
  int code = rpcPost("register_device", body, response);
  if (code != 200) {
    Serial.printf("Could not reach FloodMesh (%d) %s\n", code, response.c_str());
    return;
  }
  if (response.indexOf("code_taken") >= 0) {
    pairingCode = randomCode();
    prefs.putString("code", pairingCode);
    Serial.printf("Pairing code was taken, new code %s\n", prettyCode().c_str());
    return;
  }
  bool wasPaired = paired;
  int at = response.indexOf("\"paired\"");
  if (at >= 0) {
    String rest = response.substring(response.indexOf(':', at) + 1);
    rest.trim();
    paired = rest.startsWith("true");
  }
  if (paired && !wasPaired) {
    pairedAtMs = millis();
    Serial.println("Paired with a FloodMesh account. Sending readings.");
  }
}

void numberOrNull(char *out, size_t size, float value, int decimals) {
  if (isnan(value)) snprintf(out, size, "null");
  else snprintf(out, size, "%.*f", decimals, value);
}

void postReading(int distanceMm, float rise, float tempC, float batV, float batPct) {
  char riseS[16], tempS[16], volS[16], pctS[16];
  numberOrNull(riseS, sizeof riseS, rise, 3);
  numberOrNull(tempS, sizeof tempS, tempC, 2);
  numberOrNull(volS, sizeof volS, batV, 2);
  numberOrNull(pctS, sizeof pctS, batPct, 0);
  char body[320];
  snprintf(body, sizeof body,
           "{\"p_device_key\":\"%s\",\"p_distance_mm\":%d,\"p_rise_cm_per_min\":%s,"
           "\"p_temp_c\":%s,\"p_battery_v\":%s,\"p_battery_pct\":%s}",
           deviceKey.c_str(), distanceMm, riseS, tempS, volS, pctS);
  String response;
  int code = rpcPost("submit_reading", String(body), response);
  if (code == 200 || code == 204) {
    Serial.printf("Sent %d mm, rise %s cm/min, temp %s C\n", distanceMm, riseS, tempS);
  } else if (response.indexOf("not paired") >= 0 || response.indexOf("unknown device") >= 0) {
    paired = false;
    Serial.println("This sensor is no longer paired. Waiting for a new pairing.");
  } else {
    Serial.printf("Upload failed (%d) %s\n", code, response.c_str());
  }
}

const char PAGE_HEAD[] = R"HTML(<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FloodMesh sensor setup</title><style>
body{font-family:-apple-system,system-ui,"Segoe UI",sans-serif;margin:0;background:#fbf6ea;color:#0f2740}
header{background:#163e66;color:#fbf6ea;padding:16px 22px;display:flex;align-items:center;gap:10px;font:600 19px Georgia,serif}
header svg{width:28px;height:28px}
main{max-width:420px;margin:0 auto;padding:26px 22px 40px}
h1{font-size:23px;line-height:1.25;margin:0 0 10px}
p{line-height:1.55;color:#3e4a55;margin:0 0 12px}
label{display:block;font-weight:600;font-size:14px;margin:20px 0 6px}
select,input{width:100%;box-sizing:border-box;font-size:16px;padding:12px;border:1px solid #d8ccb2;border-radius:8px;background:#fff;color:#0f2740}
button{margin-top:24px;width:100%;font-size:16px;font-weight:600;padding:14px;border:0;border-radius:10px;background:#2f7fc1;color:#fff}
.code{font:600 36px ui-monospace,Menlo,monospace;letter-spacing:.1em;margin:14px 0 6px;padding:14px;text-align:center;background:#e3f1fb;border-radius:12px;color:#0f2740}
.small{font-size:13px;color:#6a747d}
a{color:#256aa3}
</style></head><body><header><svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="#fbf6ea"/><path d="M3.1 17.5 C 7 14.8, 10.5 14.8, 14.3 17.5 S 21.7 20.2, 25.5 17.5 C 26.6 16.7, 27.8 16.6, 28.9 17.5 A13 13 0 0 1 3.1 17.5 Z" fill="#2f7fc1"/><circle cx="16" cy="16" r="13" fill="none" stroke="#0f2740" stroke-width="2.6"/></svg>FloodMesh</header><main>)HTML";

const char PAGE_TAIL[] = "</main></body></html>";

const char STATUS_SCRIPT[] = R"HTML(<script>
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function poll(){
  try{
    const j=await (await fetch('/status',{cache:'no-store'})).json();
    const m=document.getElementById('msg');
    if(j.state==='connected'){
      m.innerHTML='<h1>'+(j.paired?'All set':'Connected to '+esc(j.ssid))+'</h1>'+
        (j.paired?'<p>This sensor is paired with your FloodMesh account and is sending readings. You can close this page.</p>':
        '<p>Open FloodMesh, choose <strong>Add a sensor</strong>, and enter this pairing code:</p><div class="code">'+esc(j.code)+'</div><p class="small">Keep this page open until the app says the sensor is paired.</p>');
      if(j.paired)return;
    }else if(j.state==='failed'){
      m.innerHTML='<h1>That didn\'t work</h1><p>The sensor couldn\'t join '+esc(j.ssid)+'. Check the password, and make sure the network is 2.4 GHz, since the sensor can\'t see 5 GHz networks.</p><p><a href="/">Try again</a></p>';
      return;
    }
  }catch(e){}
  setTimeout(poll,2000);
}
poll();
</script>)HTML";

void sendPage(const String &body) {
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "text/html", String(PAGE_HEAD) + body + PAGE_TAIL);
}

void handleRoot() {
  if (setupState == "connecting" || setupState == "connected") {
    sendPage(String("<div id=\"msg\"><h1>Connecting</h1><p>Joining ") + htmlEscape(wifiSsid)
      + ". This usually takes about ten seconds.</p></div>" + STATUS_SCRIPT);
    return;
  }
  String body = "<h1>Connect your sensor to Wi-Fi</h1>"
    "<p>Pick the network the sensor should use. It needs a 2.4 GHz network, which almost every home router provides.</p>"
    "<form method=\"POST\" action=\"/save\">"
    "<label for=\"ssid\">Wi-Fi network</label><select id=\"ssid\" name=\"ssid\">";
  body += scanOptions;
  body += "<option value=\"__other\">Another network...</option></select>"
    "<label for=\"other\" id=\"otherLabel\" style=\"display:none\">Network name</label>"
    "<input id=\"other\" name=\"other\" style=\"display:none\" autocomplete=\"off\" autocapitalize=\"off\">"
    "<label for=\"pass\">Password</label><input id=\"pass\" name=\"pass\" type=\"password\" autocomplete=\"off\">"
    "<button type=\"submit\">Connect</button></form>"
    "<p class=\"small\" style=\"margin-top:22px\">Pairing code for this sensor: <strong>";
  body += prettyCode();
  body += "</strong>. <a href=\"/rescan\">Scan for networks again</a></p>"
    "<script>const s=document.getElementById('ssid'),o=document.getElementById('other'),l=document.getElementById('otherLabel');"
    "function t(){const v=s.value==='__other';o.style.display=l.style.display=v?'block':'none';}s.onchange=t;t();</script>";
  sendPage(body);
}

void scanNetworks() {
  int n = WiFi.scanNetworks();
  scanOptions = "";
  for (int i = 0; i < n && i < 25; i++) {
    String ssid = WiFi.SSID(i);
    if (ssid.length() == 0) continue;
    String option = String("<option value=\"") + htmlEscape(ssid) + "\">" + htmlEscape(ssid) + "</option>";
    if (scanOptions.indexOf(option) >= 0) continue;
    scanOptions += option;
  }
  WiFi.scanDelete();
}

void handleRescan() {
  scanNetworks();
  server.sendHeader("Location", "/");
  server.send(302, "text/plain", "");
}

void handleSave() {
  String ssid = server.arg("ssid");
  if (ssid == "__other") ssid = server.arg("other");
  ssid.trim();
  if (ssid.length() == 0) {
    server.sendHeader("Location", "/");
    server.send(302, "text/plain", "");
    return;
  }
  wifiSsid = ssid;
  wifiPass = server.arg("pass");
  prefs.putString("ssid", wifiSsid);
  prefs.putString("pass", wifiPass);
  WiFi.disconnect();
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  setupState = "connecting";
  connectStartedMs = millis();
  sendPage(String("<div id=\"msg\"><h1>Connecting</h1><p>Joining ") + htmlEscape(wifiSsid)
    + ". This usually takes about ten seconds.</p></div>" + STATUS_SCRIPT);
}

void handleStatus() {
  String json = String("{\"state\":\"") + setupState + "\",\"ssid\":\"" + jsonEscape(wifiSsid)
    + "\",\"code\":\"" + prettyCode() + "\",\"paired\":" + (paired ? "true" : "false") + "}";
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", json);
}

void startSetup() {
  setupMode = true;
  WiFi.mode(WIFI_AP_STA);
  WiFi.setSleep(false);
  scanNetworks();
  String ap = String("FloodMesh-") + pairingCode.substring(0, 4);
  WiFi.softAP(ap.c_str());
  dns.start(53, "*", WiFi.softAPIP());
  server.on("/", HTTP_GET, handleRoot);
  server.on("/save", HTTP_POST, handleSave);
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/rescan", HTTP_GET, handleRescan);
  server.onNotFound(handleRoot);
  server.begin();
  if (wifiSsid.length() > 0) {
    WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
    setupState = "connecting";
    connectStartedMs = millis();
  }
  Serial.printf("Setup mode: join the Wi-Fi network \"%s\" on your phone. Pairing code %s\n", ap.c_str(), prettyCode().c_str());
}

void stopSetup() {
  server.stop();
  dns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  setupMode = false;
  Serial.println("Setup finished, setup network turned off.");
}

void serviceSetup() {
  dns.processNextRequest();
  server.handleClient();
  if (setupState == "connecting") {
    if (WiFi.status() == WL_CONNECTED) {
      setupState = "connected";
      Serial.printf("Joined %s\n", wifiSsid.c_str());
      registerDevice();
    } else if (millis() - connectStartedMs > 20000) {
      setupState = "failed";
      WiFi.disconnect();
      Serial.printf("Could not join %s\n", wifiSsid.c_str());
    }
  }
  if (setupState == "connected" && paired && millis() - pairedAtMs > 60000) stopSetup();
}

void serviceBootButton() {
  if (digitalRead(BOOT_PIN) == LOW) {
    if (bootPressedMs == 0) bootPressedMs = millis();
    if (millis() - bootPressedMs > 3000) {
      Serial.println("Clearing Wi-Fi settings and restarting into setup.");
      prefs.remove("ssid");
      prefs.remove("pass");
      delay(200);
      ESP.restart();
    }
  } else {
    bootPressedMs = 0;
  }
}

void serviceNetwork() {
  if (setupMode) return;
  if (WiFi.status() == WL_CONNECTED) {
    wifiLostSinceMs = 0;
    return;
  }
  if (wifiLostSinceMs == 0) wifiLostSinceMs = millis();
  if (millis() - wifiLostSinceMs > WIFI_GIVE_UP_MS) {
    Serial.println("Can't reach the saved Wi-Fi network, opening setup so it can be changed.");
    startSetup();
    return;
  }
  if (millis() - lastWifiAttemptMs > 15000) {
    lastWifiAttemptMs = millis();
    WiFi.disconnect();
    WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  }
}

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println();
  Serial.printf("FloodMesh sensor, firmware %s\n", FIRMWARE);

  pinMode(BOOT_PIN, INPUT_PULLUP);
  gpio_reset_pin(DS18B20_PIN);
  gpio_set_direction(DS18B20_PIN, GPIO_MODE_INPUT_OUTPUT_OD);
  gpio_set_pull_mode(DS18B20_PIN, GPIO_PULLUP_ONLY);
  gpio_set_level(DS18B20_PIN, 1);
  UltraSerial.begin(9600, SERIAL_8N1, ULTRA_RX_PIN, ULTRA_TX_PIN);

  loadIdentity();
  Serial.printf("Pairing code %s\n", prettyCode().c_str());
  if (wifiSsid.length() == 0) {
    startSetup();
  } else {
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
    lastWifiAttemptMs = millis();
  }
}

void loop() {
  serviceUltrasonic();
  serviceTemperature();
  sampleOncePerSecond();
  serviceBootButton();
  if (setupMode) serviceSetup();
  else serviceNetwork();

  if (WiFi.status() != WL_CONNECTED) return;
  uint32_t now = millis();
  if (!paired) {
    if (now - lastRegisterMs > REGISTER_EVERY_MS) registerDevice();
    if (!paired && now - lastCodePrintMs > 30000) {
      lastCodePrintMs = now;
      Serial.printf("Waiting to be paired. Enter code %s in the FloodMesh app.\n", prettyCode().c_str());
    }
    return;
  }
  if (now - lastPostMs >= POST_EVERY_MS) {
    lastPostMs = now;
    int distance = filteredDistance();
    if (distance < 0) {
      Serial.println("No fresh ultrasonic readings, skipping upload");
      return;
    }
    float volts, pct;
    readBattery(volts, pct);
    postReading(distance, riseRateCmPerMin(), lastTempC, volts, pct);
  }
}
