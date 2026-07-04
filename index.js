/**
 * rnode-web
 * Browser-native library to interface with RNodes in KISS/TNC mode via 
 * Web Serial or Web Bluetooth (BLE), featuring integrated Web Crypto AES-GCM encryption.
 */

const KISS = {
  FEND: 0xC0,
  FESC: 0xDB,
  TFEND: 0xDC,
  TFESC: 0xDD,
  CMD_DATA: 0x00,
  CMD_FREQUENCY: 0x01,
  CMD_BANDWIDTH: 0x02,
  CMD_SPREADING_FACTOR: 0x03,
  CMD_CODING_RATE: 0x04,
  CMD_TX_POWER: 0x05
};

// Standard Nordic UART Service (NUS) UUIDs used by RNode BLE implementations
const BLE_NUS = {
  SERVICE_UUID: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  RX_UUID: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // Write without response
  TX_UUID: '6e400003-b5a3-f393-e0a9-e50e24dcca9e'  // Notify
};

export class RNodeController extends EventTarget {
  constructor() {
    super();
    this.connectionType = null; // 'serial' | 'ble' | null
    
    // Serial Layer Handles
    this.port = null;
    this.writer = null;
    this.reader = null;
    
    // BLE Layer Handles
    this.bleDevice = null;
    this.rxCharacteristic = null;
    this.txCharacteristic = null;
    
    this.isReading = false;
    this.cryptoKey = null;
    
    // Parser State Machine Variables
    this._inFrame = false;
    this._escapeNext = false;
    this._frameBuffer = [];
    this._boundHandleBleNotification = null;
  }

  /**
   * Initializes or updates the shared AES-GCM secret key.
   * @param {string|Uint8Array} keyMaterial - Pre-shared key passphrase or a raw 32-byte array
   */
  async setPreSharedKey(keyMaterial) {
    let rawKey;
    if (typeof keyMaterial === 'string') {
      const encoder = new TextEncoder();
      const data = encoder.encode(keyMaterial);
      rawKey = await window.crypto.subtle.digest('SHA-256', data);
    } else if (keyMaterial instanceof Uint8Array && keyMaterial.length === 32) {
      rawKey = keyMaterial.buffer;
    } else {
      throw new Error("Key material must be a string or a 32-byte Uint8Array.");
    }

    this.cryptoKey = await window.crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
    
    this.dispatchEvent(new CustomEvent('key-ready'));
  }

  /**
   * Connects to an RNode via a wired Web Serial connection.
   * @param {number} [baudRate=115200]
   * @param {string} [flowControl='hardware']
   */
  async connectSerial(baudRate = 115200, flowControl = 'hardware') {
    if (this.connectionType) throw new Error("Controller already connected to an active interface.");
    if (!('serial' in navigator)) throw new Error("Web Serial API is not supported in this environment.");

    try {
      this.port = await navigator.serial.requestPort();
      await this.port.open({
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl
      });

      this.writer = this.port.writable.getWriter();
      this.connectionType = 'serial';
      this.isReading = true;
      this._startSerialReadLoop();
      
      this.dispatchEvent(new CustomEvent('connected', { detail: { type: 'serial', baudRate } }));
    } catch (error) {
      this._cleanup();
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
      throw error;
    }
  }

  /**
   * Connects to an RNode wirelessly via Web Bluetooth (BLE).
   * @param {Object} [options] - Overrides for filters or matching rules
   */
  async connectBLE(options = {}) {
    if (this.connectionType) throw new Error("Controller already connected to an active interface.");
    if (!('bluetooth' in navigator)) throw new Error("Web Bluetooth API is not supported in this environment.");

    try {
      const serviceUuid = options.serviceUuid || BLE_NUS.SERVICE_UUID;
      const rxUuid = options.rxUuid || BLE_NUS.RX_UUID;
      const txUuid = options.txUuid || BLE_NUS.TX_UUID;

      this.bleDevice = await navigator.bluetooth.requestDevice({
        filters: options.filters || [{ namePrefix: 'RNode' }, { services: [serviceUuid] }],
        optionalServices: [serviceUuid]
      });

      const service = await this._connectGattWithRetry(serviceUuid);

      this.rxCharacteristic = await service.getCharacteristic(rxUuid);
      this.txCharacteristic = await service.getCharacteristic(txUuid);

      // Start listening to the BLE TX notifications
      this._boundHandleBleNotification = this._handleBleNotification.bind(this);
      await this.txCharacteristic.startNotifications();
      this.txCharacteristic.addEventListener('characteristicvaluechanged', this._boundHandleBleNotification);

      // Handle abrupt hardware-side disconnections
      this.bleDevice.addEventListener('gattserverdisconnected', () => this._handleBleUnexpectedDisconnect());

      this.connectionType = 'ble';
      this.isReading = true;

      this.dispatchEvent(new CustomEvent('connected', { detail: { type: 'ble', name: this.bleDevice.name } }));
    } catch (error) {
      this._cleanup();
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
      throw error;
    }
  }

  /**
   * Connects the GATT server and fetches the primary service, retrying if the
   * peripheral drops the connection before service discovery completes (a
   * known Web Bluetooth quirk on first pairing with many BLE peripherals).
   */
  async _connectGattWithRetry(serviceUuid, maxAttempts = 3, retryDelayMs = 300) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const server = this.bleDevice.gatt.connected
          ? this.bleDevice.gatt
          : await this.bleDevice.gatt.connect();
        return await server.getPrimaryService(serviceUuid);
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }
    throw lastError;
  }

  /**
   * Severs the interface link and safely releases locks and hardware hooks.
   */
  async disconnect() {
    const previousType = this.connectionType;
    await this._cleanup();
    if (previousType) {
      this.dispatchEvent(new CustomEvent('disconnected', { detail: { type: previousType } }));
    }
  }

  /**
   * Internal processing structure for incoming BLE GATT notification streams.
   */
  _handleBleNotification(event) {
    const value = event.target.value; // DataView object
    const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this._parseIncomingBytes(chunk);
  }

  _handleBleUnexpectedDisconnect() {
    if (this.connectionType === 'ble') {
      this._cleanup();
      this.dispatchEvent(new CustomEvent('disconnected', { detail: { type: 'ble', unexpected: true } }));
    }
  }

  /**
   * Internal loop worker for keeping serial readers running asynchronously.
   */
  async _startSerialReadLoop() {
    while (this.isReading && this.port && this.port.readable) {
      try {
        this.reader = this.port.readable.getReader();
        while (this.isReading) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this._parseIncomingBytes(value);
        }
      } catch (error) {
        if (this.isReading) this.dispatchEvent(new CustomEvent('error', { detail: error }));
      } finally {
        if (this.reader) {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    }
  }

  /**
   * Shared algorithmic core parsing unescaped byte frames out of raw fragmented arrays.
   */
  _parseIncomingBytes(uint8ArrayChunk) {
    for (let i = 0; i < uint8ArrayChunk.length; i++) {
      const byte = uint8ArrayChunk[i];

      if (byte === KISS.FEND) {
        if (this._inFrame) {
          if (this._frameBuffer.length > 0) {
            this._processFrame(new Uint8Array(this._frameBuffer));
          }
          this._frameBuffer = [];
          this._inFrame = false;
        } else {
          this._inFrame = true;
          this._frameBuffer = [];
        }
        continue;
      }

      if (!this._inFrame) continue;

      if (this._escapeNext) {
        if (byte === KISS.TFEND) {
          this._frameBuffer.push(KISS.FEND);
        } else if (byte === KISS.TFESC) {
          this._frameBuffer.push(KISS.FESC);
        } else {
          this._frameBuffer.push(byte);
        }
        this._escapeNext = false;
      } else if (byte === KISS.FESC) {
        this._escapeNext = true;
      } else {
        this._frameBuffer.push(byte);
      }
    }
  }

  /**
   * Classifies frames and hands data layers off to event signals.
   */
  async _processFrame(rawFrame) {
    const commandByte = rawFrame[0];
    const portNumber = (commandByte >> 4) & 0x0F;
    const commandId = commandByte & 0x0F;
    const payload = rawFrame.slice(1);

    const eventMeta = { port: portNumber, commandId };

    switch (commandId) {
      case KISS.CMD_DATA:
        await this._handleIncomingData(payload, eventMeta);
        break;
      case KISS.CMD_FREQUENCY:
        this.dispatchEvent(new CustomEvent('config-frequency', { detail: { ...eventMeta, hz: this._bytesToUint32(payload) } }));
        break;
      case KISS.CMD_BANDWIDTH:
        this.dispatchEvent(new CustomEvent('config-bandwidth', { detail: { ...eventMeta, hz: this._bytesToUint32(payload) } }));
        break;
      case KISS.CMD_SPREADING_FACTOR:
        this.dispatchEvent(new CustomEvent('config-sf', { detail: { ...eventMeta, sf: payload[0] } }));
        break;
      case KISS.CMD_CODING_RATE:
        this.dispatchEvent(new CustomEvent('config-cr', { detail: { ...eventMeta, cr: payload[0] } }));
        break;
      case KISS.CMD_TX_POWER:
        this.dispatchEvent(new CustomEvent('config-power', { detail: { ...eventMeta, dbm: payload[0] } }));
        break;
      default:
        this.dispatchEvent(new CustomEvent('unknown-frame', { detail: { ...eventMeta, payload } }));
    }
  }

  /**
   * Cryptographic parser processing plain or encrypted over-the-air packets.
   */
  async _handleIncomingData(payload, meta) {
    this.dispatchEvent(new CustomEvent('raw-data', { detail: { ...meta, payload } }));
    const decoder = new TextDecoder();
    
    if (!this.cryptoKey) {
      try {
        const text = decoder.decode(payload);
        this.dispatchEvent(new CustomEvent('plaintext', { detail: { ...meta, text } }));
      } catch (_) {}
      return;
    }

    if (payload.length < 13) return; // Malformed encrypted block guard

    const iv = payload.slice(0, 12);
    const ciphertext = payload.slice(12);

    try {
      const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        this.cryptoKey,
        ciphertext
      );
      const text = decoder.decode(new Uint8Array(decryptedBuffer));
      this.dispatchEvent(new CustomEvent('decrypted-text', { detail: { ...meta, text } }));
    } catch (error) {
      this.dispatchEvent(new CustomEvent('decryption-failed', { detail: { ...meta, payload, error } }));
    }
  }

  /**
   * Packs raw parameters and streams frames across the assigned transport topology.
   */
  async _writeKissFrame(commandId, payloadArray, portNumber) {
    if (!this.connectionType) throw new Error("No active hardware interface connected.");
    
    const commandByte = ((portNumber & 0x0F) << 4) | (commandId & 0x0F);
    const frame = [KISS.FEND, commandByte];

    for (let i = 0; i < payloadArray.length; i++) {
      const byte = payloadArray[i];
      if (byte === KISS.FEND) {
        frame.push(KISS.FESC, KISS.TFEND);
      } else if (byte === KISS.FESC) {
        frame.push(KISS.FESC, KISS.TFESC);
      } else {
        frame.push(byte);
      }
    }
    frame.push(KISS.FEND);

    const serializedBytes = new Uint8Array(frame);

    // Context execution route
    if (this.connectionType === 'serial') {
      if (!this.writer) throw new Error("Serial transmission channel unavailable.");
      await this.writer.write(serializedBytes);
    } 
    else if (this.connectionType === 'ble') {
      if (!this.rxCharacteristic) throw new Error("Bluetooth write characteristic unavailable.");
      
      // Standard BLE MTU chunking safety constraint (20-byte safe windowing chunks)
      const MTU_CHUNK = 20;
      for (let offset = 0; offset < serializedBytes.length; offset += MTU_CHUNK) {
        const slice = serializedBytes.slice(offset, offset + MTU_CHUNK);
        await this.rxCharacteristic.writeValueWithoutResponse(slice);
      }
    }
  }

  /**
   * Public transmit functions
   */
  async sendRaw(payloadUint8, port = 0) { await this._writeKissFrame(KISS.CMD_DATA, payloadUint8, port); }
  async sendPlaintext(textStr, port = 0) { const encoder = new TextEncoder(); await this.sendRaw(encoder.encode(textStr), port); }
  
  async sendEncryptedText(textStr, port = 0) {
    if (!this.cryptoKey) throw new Error("Cryptographic engine unkeyed. Invoke setPreSharedKey() first.");
    
    const encoder = new TextEncoder();
    const payloadBytes = encoder.encode(textStr);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));

    const encryptedBuffer = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.cryptoKey, payloadBytes);
    const ciphertext = new Uint8Array(encryptedBuffer);

    const compoundFrame = new Uint8Array(iv.length + ciphertext.length);
    compoundFrame.set(iv, 0);
    compoundFrame.set(ciphertext, iv.length);

    await this.sendRaw(compoundFrame, port);
  }

  /**
   * Provisioning Interface Operations
   */
  async setFrequency(hz, port = 0) { await this._writeKissFrame(KISS.CMD_FREQUENCY, this._uint32ToBytes(hz), port); }
  async setBandwidth(hz, port = 0) { await this._writeKissFrame(KISS.CMD_BANDWIDTH, this._uint32ToBytes(hz), port); }
  async setSpreadingFactor(sf, port = 0) { await this._writeKissFrame(KISS.CMD_SPREADING_FACTOR, new Uint8Array([sf]), port); }
  async setCodingRate(cr, port = 0) { await this._writeKissFrame(KISS.CMD_CODING_RATE, new Uint8Array([cr]), port); }
  async setTxPower(dbm, port = 0) { await this._writeKissFrame(KISS.CMD_TX_POWER, new Uint8Array([dbm]), port); }

  /**
   * Internal explicit reset and housecleaning pipeline
   */
  async _cleanup() {
    this.isReading = false;
    this.connectionType = null;

    // Serial Teardown
    if (this.reader) { try { await this.reader.cancel(); } catch (_) {} this.reader = null; }
    if (this.writer) { try { this.writer.releaseLock(); } catch (_) {} this.writer = null; }
    if (this.port) { try { await this.port.close(); } catch (_) {} this.port = null; }

    // BLE Teardown
    if (this.txCharacteristic && this._boundHandleBleNotification) {
      try {
        await this.txCharacteristic.stopNotifications();
        this.txCharacteristic.removeEventListener('characteristicvaluechanged', this._boundHandleBleNotification);
      } catch (_) {}
    }
    this.txCharacteristic = null;
    this.rxCharacteristic = null;
    this._boundHandleBleNotification = null;

    if (this.bleDevice && this.bleDevice.gatt.connected) {
      try { this.bleDevice.gatt.disconnect(); } catch (_) {}
    }
    this.bleDevice = null;
  }

  _uint32ToBytes(value) {
    const buf = new Uint8Array(4);
    buf[0] = (value >> 24) & 0xFF;
    buf[1] = (value >> 16) & 0xFF;
    buf[2] = (value >> 8) & 0xFF;
    buf[3] = value & 0xFF;
    return buf;
  }

  _bytesToUint32(uint8Array) {
    const dataView = new DataView(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength);
    return dataView.getUint32(0, false);
  }
}
