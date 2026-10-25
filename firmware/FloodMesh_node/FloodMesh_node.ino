// FloodMesh sensor node
// ESP32-S3 + A02YYUW ultrasonic (UART controlled) + DS18B20 temperature probe.
// Filters the distance readings, works out how fast the water is rising, and sends
// a reading to Supabase every 10 seconds.
//
// Arduino IDE: Board "ESP32S3 Dev Module", USB CDC On Boot "Disabled",
// Flash Size "16MB (128Mb)", PSRAM "OPI PSRAM". Serial Monitor at 115200 baud.
// No extra libraries needed.

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "driver/gpio.h"

// ---------------- Fill these in ----------------
const char *WIFI_SSID     = "YOUR_WIFI_NAME";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char *DEVICE_KEY    = "PASTE_DEVICE_KEY_HERE";

// ---------------- Project settings ----------------
const char *SUPABASE_URL = "https://nqwgfnpksaqsvyzitwax.supabase.co";
const char *SUPABASE_KEY = "sb_publishable_eI3c2zcEgRGGSH2K75bmZw_GYwGLi2l";
const uint32_t POST_EVERY_MS = 10000;  // how often to send a reading
const int RISE_WINDOW_S = 60;          // rise rate is fitted over the last minute

// Optional battery monitor: battery + -> 100k -> GPIO1 -> 100k -> GND.
// Leave false until that divider is wired.
const bool BATTERY_WIRED = false;
const int BATTERY_PIN = 1;

// ---------------- Pins (same as the hardware test) ----------------
const gpio_num_t DS18B20_PIN = GPIO_NUM_4;
const int ULTRA_RX_PIN = 18;  // ESP32 listens here   <- sensor TX wire
const int ULTRA_TX_PIN = 17;  // ESP32 talks here     -> 1k resistor -> sensor RX wire

HardwareSerial UltraSerial(1);

// ---------------- DS18B20 (1-Wire, unchanged from the hardware test) ----------------
static portMUX_TYPE owMux = portMUX_INITIALIZER_UNLOCKED;

static inline void owLow()     { gpio_set_level(DS18B20_PIN, 0); }
static inline void owRelease() { gpio_set_level(DS18B20_PIN, 1); }
static inline int  owRead()    { return gpio_get_level(DS18B20_PIN); }

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
  if (bit) { delayMicroseconds(6);  owRelease(); delayMicroseconds(64); }
  else     { delayMicroseconds(60); owRelease(); delayMicroseconds(10); }
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

// ---------------- Ultrasonic frames ----------------
const int FRAME_BUF = 9;
int frames[FRAME_BUF];
int frameCount = 0;
int frameIdx = 0;
uint32_t lastFrameMs = 0;

uint8_t win[4] = {0, 0, 0, 0};
uint32_t lastTriggerMs = 0;

void onFrame(int mm) {
  if (mm < 30 || mm > 4500) return;  // inside the blind zone or no echo
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

// ---------------- One-second history for filtering and rise rate ----------------
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
  if (frameCount < 3 || now - lastFrameMs > 2000) return;  // not enough fresh echoes
  histMs[histIdx] = now;
  histMm[histIdx] = medianOf(frames, frameCount);
  histIdx = (histIdx + 1) % HIST;
  if (histCount < HIST) histCount++;
}

// Median of the newest few one-second samples, or -1 if the sensor has gone quiet.
int filteredDistance() {
  if (histCount == 0) return -1;
  int newest = (histIdx - 1 + HIST) % HIST;
  if (millis() - histMs[newest] > 5000) return -1;
  int n = histCount < 5 ? histCount : 5;
  int vals[5];
  for (int i = 0; i < n; i++) vals[i] = histMm[(histIdx - 1 - i + HIST) % HIST];
  return medianOf(vals, n);
}

// Least-squares slope of distance over the last RISE_WINDOW_S seconds.
// Distance shrinking means water rising, so the sign is flipped.
// Returns cm per minute, or NAN without enough data.
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
  return (float)(-slopeMmPerS * 6.0);  // mm/s * 60 s/min / 10 mm/cm
}

// ---------------- Battery (optional) ----------------
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

// ---------------- Wi-Fi and upload ----------------
uint32_t lastWifiAttemptMs = 0;

void startWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // keeps current draw steady so the solar board's 5V output stays on
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiAttemptMs = millis();
}

void keepWifiAlive() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiAttemptMs < 15000) return;
  Serial.println("Wi-Fi lost, reconnecting");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiAttemptMs = millis();
}

void numberOrNull(char *out, size_t size, float value, int decimals) {
  if (isnan(value)) snprintf(out, size, "null");
  else snprintf(out, size, "%.*f", decimals, value);
}

bool postReading(int distanceMm, float rise, float tempC, float batV, float batPct) {
  WiFiClientSecure client;
  client.setInsecure();  // prototype: skips certificate checks. Pin the root CA for deployment.
  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/rpc/submit_reading";
  if (!http.begin(client, url)) {
    Serial.println("Could not start HTTPS request");
    return false;
  }
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("apikey", SUPABASE_KEY);

  char riseS[16], tempS[16], volS[16], pctS[16];
  numberOrNull(riseS, sizeof riseS, rise, 3);
  numberOrNull(tempS, sizeof tempS, tempC, 2);
  numberOrNull(volS, sizeof volS, batV, 2);
  numberOrNull(pctS, sizeof pctS, batPct, 0);

  char body[320];
  snprintf(body, sizeof body,
           "{\"p_device_key\":\"%s\",\"p_distance_mm\":%d,\"p_rise_cm_per_min\":%s,"
           "\"p_temp_c\":%s,\"p_battery_v\":%s,\"p_battery_pct\":%s}",
           DEVICE_KEY, distanceMm, riseS, tempS, volS, pctS);

  int code = http.POST(String(body));
  String response = (code > 0 && code != 204) ? http.getString() : String("");
  http.end();

  if (code == 200 || code == 204) {
    Serial.printf("Sent  %d mm  rise %s cm/min  temp %s C\n", distanceMm, riseS, tempS);
    return true;
  }
  Serial.printf("Upload failed (%d) %s\n", code, response.c_str());
  return false;
}

// ---------------- Main ----------------
uint32_t lastPostMs = 0;

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.println();
  Serial.println("=== FloodMesh sensor node ===");

  gpio_reset_pin(DS18B20_PIN);
  gpio_set_direction(DS18B20_PIN, GPIO_MODE_INPUT_OUTPUT_OD);
  gpio_set_pull_mode(DS18B20_PIN, GPIO_PULLUP_ONLY);
  gpio_set_level(DS18B20_PIN, 1);

  UltraSerial.begin(9600, SERIAL_8N1, ULTRA_RX_PIN, ULTRA_TX_PIN);

  Serial.printf("Connecting to %s\n", WIFI_SSID);
  startWifi();
}

void loop() {
  serviceUltrasonic();
  serviceTemperature();
  sampleOncePerSecond();
  keepWifiAlive();

  static bool announced = false;
  if (WiFi.status() == WL_CONNECTED && !announced) {
    Serial.printf("Wi-Fi connected, IP %s\n", WiFi.localIP().toString().c_str());
    announced = true;
  } else if (WiFi.status() != WL_CONNECTED) {
    announced = false;
  }

  uint32_t now = millis();
  if (now - lastPostMs >= POST_EVERY_MS) {
    lastPostMs = now;
    int distance = filteredDistance();
    if (distance < 0) {
      Serial.println("No fresh ultrasonic readings, skipping upload");
    } else if (WiFi.status() != WL_CONNECTED) {
      Serial.printf("Offline, latest distance %d mm\n", distance);
    } else {
      float volts, pct;
      readBattery(volts, pct);
      postReading(distance, riseRateCmPerMin(), lastTempC, volts, pct);
    }
  }
}
