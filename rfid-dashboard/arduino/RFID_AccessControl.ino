/**
 * RFID Access Control — надёжная версия для дашборда
 * 
 * Возможности:
 * - Чтение UID карты → SCAN:A1B2C3D4
 * - Чтение блока → команда RDATA в дашборде
 * - Запись блока → команда WRITE:sector:block:hex из дашборда
 * - Heartbeat для стабильного соединения
 * - Debounce — нет дублей при удержании карты
 */

#include <stdio.h>
#include <SPI.h>
#include <MFRC522.h>

#define RST_PIN    9
#define SS_PIN     10
#define LED_PIN    2
#define LED_ERR    LED_PIN    // тот же LED для ошибок (3 коротких моргания)

#define HEARTBEAT_MS   8000   // пинг каждые 8 сек
#define DEBOUNCE_MS    2500   // пауза между сканами той же карты
#define INIT_RETRIES   5      // попыток инициализации MFRC522
#define INIT_DELAY_MS  500

MFRC522 mfrc522(SS_PIN, RST_PIN);
MFRC522::MIFARE_Key key;

unsigned long lastHeartbeat = 0;
unsigned long lastScanTime = 0;
String lastScanUid = "";
bool mfrcReady = false;

// Leonardo/Micro: ждём Serial
void waitForSerial() {
#if defined(__AVR_ATmega32U4__) || defined(ARDUINO_SAM_DUE)
  unsigned long t = millis();
  while (!Serial && (millis() - t < 5000)) { delay(10); }
#endif
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.begin(9600);
  waitForSerial();
  
  // Даём питанию стабилизироваться
  delay(300);
  
  SPI.begin();
  
  // Инициализация MFRC522 с повторными попытками
  for (byte i = 0; i < INIT_RETRIES; i++) {
    mfrc522.PCD_Init();
    delay(50);
    mfrc522.PCD_SetAntennaGain(mfrc522.RxGain_max);  // макс. чувствительность
    
    byte v = mfrc522.PCD_ReadRegister(mfrc522.VersionReg);
    if (v == 0x00 || v == 0xFF) {
      if (i < INIT_RETRIES - 1) {
        delay(INIT_DELAY_MS);
        continue;
      }
      mfrcReady = false;
      Serial.println("INIT_ERR:MFRC522");
      break;
    }
    mfrcReady = true;
    break;
  }

  // Ключ по умолчанию (фабричный)
  for (byte i = 0; i < 6; i++) {
    key.keyByte[i] = 0xFF;
  }

  // Сигнал дашборду: всё готово
  Serial.println("SYSTEM_READY");
  blinkLed(LED_PIN, 2);
}

void loop() {
  // Heartbeat — держим соединение
  if (millis() - lastHeartbeat >= HEARTBEAT_MS) {
    Serial.println("PING");
    lastHeartbeat = millis();
  }

  // Проверка команд из дашборда (запись и т.д.)
  processSerialCommands();

  if (!mfrcReady) {
    delay(500);
    return;
  }

  // Новая карта?
  if (!mfrc522.PICC_IsNewCardPresent() || !mfrc522.PICC_ReadCardSerial()) {
    return;
  }

  // Debounce: та же карта в течение DEBOUNCE_MS — игнор
  String uidStr = uidToString(mfrc522.uid);
  unsigned long now = millis();
  if (uidStr == lastScanUid && (now - lastScanTime) < DEBOUNCE_MS) {
    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
    return;
  }

  lastScanUid = uidStr;
  lastScanTime = now;

  // Сначала UID, затем полный дамп (пока карта ещё выбрана)
  Serial.print("SCAN:");
  Serial.println(uidStr);
  sendFullCardDetails();

  digitalWrite(LED_PIN, HIGH);
  delay(300);
  digitalWrite(LED_PIN, LOW);

  mfrc522.PICC_HaltA();
  mfrc522.PCD_StopCrypto1();
}

// Печать META:KEY=VALUE (значение без перевода строк)
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

/** Вся доступная информация о карте (MFRC522 + MIFARE) */
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

  // Размер памяти по типу
  int memKb = 0;
  if (piccType == MFRC522::PICC_TYPE_MIFARE_MINI) memKb = 1;
  else if (piccType == MFRC522::PICC_TYPE_MIFARE_1K) memKb = 1;
  else if (piccType == MFRC522::PICC_TYPE_MIFARE_4K) memKb = 4;
  metaLineInt("MEM_KB_HINT", memKb);

  byte buffer[18];
  byte bufSize = sizeof(buffer);

  // --- MIFARE Classic: сектор 0, ключ FF..FF ---
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
  // --- MIFARE Ultralight / NTAG: страницы 0–15 ---
  // В старых версиях MFRC522 нет MIFARE_Ultralight_Read — используем MIFARE_Read:
  // для Ultralight одна команда читает 4 страницы подряд (16 байт), адрес = первая страница.
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

// Собрать UID в строку "A1B2C3D4"
String uidToString(MFRC522::Uid uid) {
  String s = "";
  for (byte i = 0; i < uid.size; i++) {
    if (uid.uidByte[i] < 0x10) s += "0";
    s += String(uid.uidByte[i], HEX);
  }
  s.toUpperCase();
  return s;
}

void blinkLed(uint8_t pin, uint8_t n) {
  for (uint8_t i = 0; i < n; i++) {
    digitalWrite(pin, HIGH);
    delay(80);
    digitalWrite(pin, LOW);
    delay(80);
  }
}

// Чтение команд из Serial
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

  // PING (4 символа) — ответ PONG; нельзя требовать length>=5
  if (cmd == "PING" || cmd.startsWith("PING")) {
    Serial.println("PONG");
    return;
  }

  // WRITE:sector:block:hex16bytes  (32 hex символа)
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
      }
    } else {
      Serial.println("WRITE_ERR:format");
    }
    return;
  }
}

// Запись в блок — ждём карту до 15 сек
void cmdWriteBlock(byte sector, byte blockNum, String hexStr) {
  unsigned long waitStart = millis();
  while (!mfrc522.PICC_IsNewCardPresent() || !mfrc522.PICC_ReadCardSerial()) {
    processSerialCommands();  // не блокируем входящие
    if (millis() - waitStart > 15000) {
      Serial.println("WRITE_ERR:no_card");
      return;
    }
    delay(50);
  }

  byte blockAddr = sector * 4 + (blockNum % 4);
  if (blockAddr % 4 == 3) {
    Serial.println("WRITE_ERR:trailer");
    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
    return;  // sector trailer не трогаем
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
    blinkLed(LED_PIN, 5);
    mfrc522.PICC_HaltA();
    mfrc522.PCD_StopCrypto1();
    return;
  }

  status = (MFRC522::StatusCode)mfrc522.MIFARE_Write(blockAddr, dataBlock, 16);
  mfrc522.PICC_HaltA();
  mfrc522.PCD_StopCrypto1();

  if (status == MFRC522::STATUS_OK) {
    Serial.println("WRITE_OK");
    blinkLed(LED_PIN, 3);
  } else {
    Serial.print("WRITE_ERR:");
    Serial.println(mfrc522.GetStatusCodeName(status));
    blinkLed(LED_PIN, 5);
  }
}
