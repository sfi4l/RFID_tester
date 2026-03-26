/**
 * RFID Access Control — версия с RGB (Общий Анод) + Кастомный старт
 */

#include <stdio.h>
#include <SPI.h>
#include <MFRC522.h>

#define RST_PIN       9
#define SS_PIN        10

// Наши ШИМ-пины для RGB
#define LED_R         5   // Красный
#define LED_G         3   // Зеленый 
#define LED_B         6   // Синий 

// Значения для ШИМ (Общий анод: 0 = максимум яркости, 255 = выключен)
#define LED_ON_MAX    0
#define LED_OFF       255

#define HEARTBEAT_MS   8000
#define DEBOUNCE_MS    2500
#define INIT_RETRIES   5
#define INIT_DELAY_MS  500

MFRC522 mfrc522(SS_PIN, RST_PIN);
MFRC522::MIFARE_Key key;

unsigned long lastHeartbeat = 0;
unsigned long lastScanTime = 0;
String lastScanUid = "";
bool mfrcReady = false;

// Глобальная переменная для управления эффектом "дыхания"
bool isIdle = true; 
bool manualColorEnabled = false;
uint8_t manualColorR = 0;
uint8_t manualColorG = 0;
uint8_t manualColorB = 0;

uint8_t rgbToPwm(uint8_t value) {
  return (uint8_t)(255 - value);
}

void applyRgb(uint8_t r, uint8_t g, uint8_t b) {
  analogWrite(LED_R, rgbToPwm(r));
  analogWrite(LED_G, rgbToPwm(g));
  analogWrite(LED_B, rgbToPwm(b));
}

int hexDigitToInt(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

bool parseHexByte(String s, uint8_t *out) {
  if (s.length() != 2) return false;
  int h = hexDigitToInt(s.charAt(0));
  int l = hexDigitToInt(s.charAt(1));
  if (h < 0 || l < 0) return false;
  *out = (uint8_t)((h << 4) | l);
  return true;
}

void waitForSerial() {
#if defined(__AVR_ATmega32U4__) || defined(ARDUINO_SAM_DUE)
  unsigned long t = millis();
  while (!Serial && (millis() - t < 5000)) { delay(10); }
#endif
}

void turnOffLeds() {
  analogWrite(LED_R, LED_OFF);
  analogWrite(LED_G, LED_OFF);
  analogWrite(LED_B, LED_OFF);
}

// === НОВАЯ СТАРТОВАЯ АНИМАЦИЯ ===
void startupAnimation() {
  isIdle = false; // Отключаем дыхание на время анимации
  
  // 1. Горим желтым 3 секунды. 
  // Глушим красный (150), зеленый на максимум (0), синий выключен (255)
  analogWrite(LED_R, 150); 
  analogWrite(LED_G, LED_ON_MAX);   
  analogWrite(LED_B, LED_OFF); 
  delay(3000);

  // 2. Чуть горим зеленым (1 секунду)
  analogWrite(LED_R, LED_OFF);
  analogWrite(LED_G, LED_ON_MAX);
  analogWrite(LED_B, LED_OFF);
  delay(1000);

  // Выключаем всё перед переходом в режим ожидания
  turnOffLeds();
  isIdle = true; // Разрешаем синее "дыхание" в loop()
}

// Функция плавного "дыхания" синим цветом
void breatheBlue() {
  unsigned long time = millis() % 2000;
  int brightness;

  if (time < 1000) {
    brightness = map(time, 0, 1000, 255, 0);
  } else {
    brightness = map(time, 1000, 2000, 0, 255);
  }
  
  analogWrite(LED_B, brightness);
  analogWrite(LED_R, LED_OFF);
  analogWrite(LED_G, LED_OFF);
}

// Функция для жесткого мигания (индикация успеха/ошибки)
void blinkLedAnalog(uint8_t pin, uint8_t n) {
  isIdle = false; 
  turnOffLeds();
  
  for (uint8_t i = 0; i < n; i++) {
    analogWrite(pin, LED_ON_MAX);
    delay(100);
    analogWrite(pin, LED_OFF);
    delay(100);
  }
  isIdle = true; 
}


void setup() {
  pinMode(LED_G, OUTPUT);
  pinMode(LED_B, OUTPUT);
  pinMode(LED_R, OUTPUT);
  
  turnOffLeds();

  Serial.begin(9600);
  waitForSerial();
  
  delay(300);
  SPI.begin();
  
  for (byte i = 0; i < INIT_RETRIES; i++) {
    mfrc522.PCD_Init();
    delay(50);
    mfrc522.PCD_SetAntennaGain(mfrc522.RxGain_max);
    
    byte v = mfrc522.PCD_ReadRegister(mfrc522.VersionReg);
    if (v == 0x00 || v == 0xFF) {
      if (i < INIT_RETRIES - 1) {
        delay(INIT_DELAY_MS);
        continue;
      }
      mfrcReady = false;
      Serial.println("INIT_ERR:MFRC522");
      analogWrite(LED_R, LED_ON_MAX); 
      isIdle = false;
      break;
    }
    mfrcReady = true;
    break;
  }

  for (byte i = 0; i < 6; i++) {
    key.keyByte[i] = 0xFF;
  }

  if (mfrcReady) {
    Serial.println("SYSTEM_READY");
    startupAnimation(); // Вызываем нашу новую красивую анимацию
  }
}

void loop() {
  if (isIdle && mfrcReady) {
    if (manualColorEnabled) {
      applyRgb(manualColorR, manualColorG, manualColorB);
    } else {
      breatheBlue();
    }
  }

  if (millis() - lastHeartbeat >= HEARTBEAT_MS) {
    Serial.println("PING");
    lastHeartbeat = millis();
  }

  processSerialCommands();

  if (!mfrcReady) {
    delay(500);
    return;
  }

  if (!mfrc522.PICC_IsNewCardPresent() || !mfrc522.PICC_ReadCardSerial()) {
    return;
  }

  String uidStr = uidToString(mfrc522.uid);
  unsigned long now = millis();
  if (uidStr == lastScanUid && (now - lastScanTime) < DEBOUNCE_MS) {
    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
    return;
  }

  lastScanUid = uidStr;
  lastScanTime = now;

  Serial.print("SCAN:");
  Serial.println(uidStr);
  sendFullCardDetails();

  blinkLedAnalog(LED_G, 1);

  mfrc522.PICC_HaltA();
  mfrc522.PCD_StopCrypto1();
}

void metaLine(const char *key, const char *val) {
  Serial.print("META:");
  Serial.print(key);
  Serial.print("=");
  Serial.println(val);
}

void metaLineInt(const char *key, int v) {
  Serial.print("META:");
  Serial.print(key);
  Serial.print("=");
  Serial.println(v);
}

void metaHex(const char *key, byte *buf, byte len) {
  Serial.print("META:");
  Serial.print(key);
  Serial.print("=");
  for (byte i = 0; i < len; i++) {
    if (buf[i] < 0x10) Serial.print("0");
    Serial.print(buf[i], HEX);
  }
  Serial.println();
}

void sendFullCardDetails() {
  MFRC522::PICC_Type piccType = mfrc522.PICC_GetType(mfrc522.uid.sak);

  metaLineInt("PICC_TYPE_ID", (int)piccType);
  Serial.print("META:PICC_TYPE_NAME=");
  Serial.println(mfrc522.PICC_GetTypeName(piccType));
  metaLineInt("UID_LEN_BYTES", (int)mfrc522.uid.size);
  metaHex("UID_RAW", mfrc522.uid.uidByte, mfrc522.uid.size);

  Serial.print("META:SAK=");
  if (mfrc522.uid.sak < 0x10) Serial.print("0");
  Serial.println(mfrc522.uid.sak, HEX);

  int memKb = 0;
  if (piccType == MFRC522::PICC_TYPE_MIFARE_MINI) memKb = 1;
  else if (piccType == MFRC522::PICC_TYPE_MIFARE_1K) memKb = 1;
  else if (piccType == MFRC522::PICC_TYPE_MIFARE_4K) memKb = 4;
  metaLineInt("MEM_KB_HINT", memKb);

  byte buffer[18];
  byte bufSize = sizeof(buffer);

  if (piccType == MFRC522::PICC_TYPE_MIFARE_MINI ||
      piccType == MFRC522::PICC_TYPE_MIFARE_1K ||
      piccType == MFRC522::PICC_TYPE_MIFARE_4K) {

    byte trailerBlock = 3;
    MFRC522::StatusCode st = (MFRC522::StatusCode)mfrc522.PCD_Authenticate(
      MFRC522::PICC_CMD_MF_AUTH_KEY_A, trailerBlock, &key, &(mfrc522.uid));
    if (st == MFRC522::STATUS_OK) {
      metaLine("SECTOR0_AUTH", "OK_KEY_A");
    } else {
      metaLineInt("SECTOR0_AUTH_ERR", (int)st);
    }

    if (st == MFRC522::STATUS_OK) {
      for (byte b = 0; b < 4; b++) {
        bufSize = sizeof(buffer);
        st = (MFRC522::StatusCode)mfrc522.MIFARE_Read(b, buffer, &bufSize);
        char keyb[16];
        snprintf(keyb, sizeof(keyb), "BLK_S0_%u", b);
        if (st == MFRC522::STATUS_OK) {
          metaHex(keyb, buffer, 16);
        } else {
          metaLine(keyb, "READ_ERR");
        }
      }
    }
  }
  else if (piccType == MFRC522::PICC_TYPE_MIFARE_UL) {
    metaLine("FAMILY", "Ultralight_NTAG");
    for (byte page = 0; page < 16; page += 4) {
      bufSize = sizeof(buffer);
      MFRC522::StatusCode stu = (MFRC522::StatusCode)mfrc522.MIFARE_Read(page, buffer, &bufSize);
      if (stu == MFRC522::STATUS_OK) {
        for (byte b = 0; b < 4; b++) {
          char kp[20];
          snprintf(kp, sizeof(kp), "UL_PAGE_%u", (unsigned int)(page + b));
          metaHex(kp, buffer + b * 4, 4);
        }
      } else {
        char kp[24];
        snprintf(kp, sizeof(kp), "UL_READ_ERR_%u", (unsigned int)page);
        metaLine(kp, "READ_ERR");
        if (page > 4) break;
      }
    }
  }
  else {
    metaLine("NOTE", "NO_EXTRA_MEMORY_DUMP_FOR_THIS_PICC_TYPE");
  }

  Serial.println("CARD_END");
}

String uidToString(MFRC522::Uid uid) {
  String s = "";
  for (byte i = 0; i < uid.size; i++) {
    if (uid.uidByte[i] < 0x10) s += "0";
    s += String(uid.uidByte[i], HEX);
  }
  s.toUpperCase();
  return s;
}

void processSerialCommands() {
  static String cmdBuffer = "";

  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (cmdBuffer.length() > 0) {
        handleCommand(cmdBuffer);
        cmdBuffer = "";
      }
    } else if (c >= 32 && c < 127) {
      cmdBuffer += c;
      if (cmdBuffer.length() > 120) cmdBuffer = "";
    }
  }
}

void handleCommand(String cmd) {
  cmd.trim();
  if (cmd.length() < 1) return;

  if (cmd == "PING" || cmd.startsWith("PING")) {
    Serial.println("PONG");
    return;
  }

  if (cmd.startsWith("WRITE:")) {
    int i1 = cmd.indexOf(':', 6);
    int i2 = cmd.indexOf(':', i1 + 1);
    int i3 = cmd.indexOf(':', i2 + 1);
    if (i1 > 0 && i2 > 0 && i3 > 0) {
      byte sector = cmd.substring(6, i1).toInt();
      byte block = cmd.substring(i1 + 1, i2).toInt();
      String hexData = cmd.substring(i3 + 1);
      hexData.replace(" ", "");
      
      if (hexData.length() >= 32) {
        hexData = hexData.substring(0, 32);
        cmdWriteBlock(sector, block, hexData);
      } else {
        Serial.println("WRITE_ERR:bad_data");
        blinkLedAnalog(LED_R, 3);
      }
    } else {
      Serial.println("WRITE_ERR:format");
      blinkLedAnalog(LED_R, 3);
    }
    return;
  }

  if (cmd.startsWith("RGB:")) {
    String payload = cmd.substring(4);
    payload.trim();

    if (payload == "AUTO") {
      manualColorEnabled = false;
      Serial.println("RGB_OK:AUTO");
      return;
    }

    if (payload.length() == 6) {
      uint8_t r, g, b;
      bool ok = parseHexByte(payload.substring(0, 2), &r) &&
                parseHexByte(payload.substring(2, 4), &g) &&
                parseHexByte(payload.substring(4, 6), &b);
      if (!ok) {
        Serial.println("RGB_ERR:bad_hex");
        blinkLedAnalog(LED_R, 2);
        return;
      }

      manualColorR = r;
      manualColorG = g;
      manualColorB = b;
      manualColorEnabled = true;
      if (isIdle) {
        applyRgb(manualColorR, manualColorG, manualColorB);
      }
      Serial.println("RGB_OK");
      return;
    }

    Serial.println("RGB_ERR:format");
    blinkLedAnalog(LED_R, 2);
    return;
  }
}

void cmdWriteBlock(byte sector, byte blockNum, String hexStr) {
  unsigned long waitStart = millis();
  isIdle = false; 
  turnOffLeds();
  analogWrite(LED_B, 100); 

  while (!mfrc522.PICC_IsNewCardPresent() || !mfrc522.PICC_ReadCardSerial()) {
    processSerialCommands();  
    if (millis() - waitStart > 15000) {
      Serial.println("WRITE_ERR:no_card");
      blinkLedAnalog(LED_R, 3);
      isIdle = true;
      return;
    }
    delay(50);
  }

  byte blockAddr = sector * 4 + (blockNum % 4);
  if (blockAddr % 4 == 3) {
    Serial.println("WRITE_ERR:trailer");
    blinkLedAnalog(LED_R, 3);
    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
    isIdle = true;
    return;  
  }

  byte dataBlock[16];
  for (int i = 0; i < 16 && i * 2 < hexStr.length(); i++) {
    dataBlock[i] = (byte)strtol(hexStr.substring(i * 2, i * 2 + 2).c_str(), NULL, 16);
  }

  byte trailerBlock = (sector + 1) * 4 - 1;
  MFRC522::StatusCode status = (MFRC522::StatusCode)mfrc522.PCD_Authenticate(
    MFRC522::PICC_CMD_MF_AUTH_KEY_A, trailerBlock, &key, &(mfrc522.uid)
  );

  if (status != MFRC522::STATUS_OK) {
    Serial.print("WRITE_ERR:auth ");
    Serial.println(mfrc522.GetStatusCodeName(status));
    blinkLedAnalog(LED_R, 5);
    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
    isIdle = true;
    return;
  }

  status = (MFRC522::StatusCode)mfrc522.MIFARE_Write(blockAddr, dataBlock, 16);
  mfrc522.PICC_HaltA();
  mfrc522.PCD_StopCrypto1();

  if (status == MFRC522::STATUS_OK) {
    Serial.println("WRITE_OK");
    blinkLedAnalog(LED_G, 3); 
  } else {
    Serial.print("WRITE_ERR:");
    Serial.println(mfrc522.GetStatusCodeName(status));
    blinkLedAnalog(LED_R, 5); 
  }
  isIdle = true; 
}