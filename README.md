Here is a comprehensive, production-ready `README.md` for your package. It clearly documents the hybrid connection topology, the cryptographic pipelines, and the event-driven architecture so that anyone integration-testing your library can get up and running instantly.

---

# rnode-web

A browser-native, zero-dependency JavaScript library designed to interface directly with **LoRa RNodes** configured in **KISS/TNC mode**. By leveraging the modern **Web Serial** and **Web Bluetooth (BLE)** APIs, this package allows you to deploy client-side off-grid messaging apps, telemetry dashboards, or provisioning utilities straight from a standard web URL—completely free of local Python, `pip`, or compiled native driver toolchains.

It includes an integrated, hardware-accelerated encryption layer running on the browser's native **Web Crypto API** to keep your over-the-air payloads safe from external sniffers.

---

## ⚡ Features

* 🔌 **Dual-Transport Topology:** Transparent runtime toggling between wired USB connections (`Web Serial API`) and wireless mobile links (`Web Bluetooth API`).
* 🔒 **End-to-End Encryption:** Automated, hardware-accelerated **AES-GCM (256-bit)** data pipelining with unique 12-byte initialization vector (IV) injection per packet.
* 📟 **KISS State Machine Parser:** Built-in byte boundary and character escaping (`FEND`/`FESC`) that gracefully stitches together fragmented asynchronous serial streams.
* 📡 **Hardware Configuration Interface:** Direct abstraction methods to query and rewrite RNode transceiver values (Frequency, Spreading Factor, Bandwidth, Coding Rate, TX Power).
* 🎛️ **Reactive Event-Driven Architecture:** Extends native browser `EventTarget` enabling clean decouple mechanics using declarative `.addEventListener()` hooks.

---

## 📦 Installation

Install the package into your project via npm:

```bash
npm install rnode-web

```

Or consume it directly in native browser modules using an ESM CDN:

```javascript
import { RNodeController } from 'https://esm.sh/rnode-web';

```

---

## 🚀 Quick Start Guide

### 1. Initialize and Manage Cryptography

The controller handles key derivation under the hood. You can seed the engine using a custom string passphrase or pass a cryptographically strong 32-byte binary array.

```javascript
import { RNodeController } from 'rnode-web';

const rnode = new RNodeController();

// Initialize an encrypted session using a passphrase
await rnode.setPreSharedKey("My_OffGrid_Mesh_Secret_Password");

```

### 2. Establish Hardware Connections

> ⚠️ **Browser Security Constraint:** Both Web Serial and Web Bluetooth requests must be executed inside a direct user-interaction callback handler (such as a button click event).

#### Option A: Wired Connection (Web Serial)

Typically maps to standard desktop USB environments matching default RNode firmware baud rates.

```javascript
document.getElementById('btn-connect-usb').addEventListener('click', async () => {
  try {
    // connectSerial(baudRate, flowControl)
    await rnode.connectSerial(115200, 'hardware');
    console.log("Wired RNode link established.");
  } catch (err) {
    console.error("Wired hook failed:", err);
  }
});

```

#### Option B: Wireless Connection (Web Bluetooth / BLE)

Maps to mobile browsers and tablets using the transparent Nordic UART Service (NUS) profile.

```javascript
document.getElementById('btn-connect-ble').addEventListener('click', async () => {
  try {
    await rnode.connectBLE();
    console.log("Wireless BLE RNode link established.");
  } catch (err) {
    console.error("Bluetooth pairing or discovery failed:", err);
  }
});

```

> ℹ️ **Note on BLE Pairing:** RNode implementations configure characteristics as protected attributes. When your app executes its first transmission or starts listening to notifications, the host operating system will automatically hijack focus and prompt the user for the RNode's 6-digit Bluetooth pairing PIN.

---

## 📡 Transmitting Data Over the Air

Once connected, your application can transmit across three different operational abstraction tiers:

```javascript
// 1. Secure Text Transmission (AES-GCM 256-bit)
// Automatically prepends a random 12-byte IV, encrypts the text, and applies KISS framing.
await rnode.sendEncryptedText("Hello encrypted world!");

// 2. Cleartext Broadcast Transmission
// Transmits standard unencrypted UTF-8 text readable by any sniffer on the same frequency.
await rnode.sendPlaintext("Public broadcast message.");

// 3. Raw Hex / Protocol-Agnostic Buffer Transmission
// Transmits raw un-escaped bytes (e.g., custom data packet schemas, AX.25, or Reticulum frames)
const customBytes = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
await rnode.sendRaw(customBytes);

```

---

## 🎛️ Handling Inbound Streams & Events

The library abstracts all stream data sorting. Subscribe directly to the instance events to update your user interface in real-time:

### Traffic Handlers

| Event Name | Event Object Details (`e.detail`) | Description |
| --- | --- | --- |
| `'decrypted-text'` | `{ text, port, commandId }` | Fires when an inbound secure packet is intercepted and successfully decrypted via your key. |
| `'plaintext'` | `{ text, port, commandId }` | Fires when unencrypted readable plaintext arrives on the antenna. |
| `'raw-data'` | `{ payload, port, commandId }` | Fires for *every* data packet, returning the raw unescaped `Uint8Array` binary layout. |
| `'decryption-failed'` | `{ payload, error, port }` | Fires when encrypted frames arrive but fail to decode (due to corrupt bytes or a key mismatch). |

### Connection & Configuration Status Handlers

| Event Name | Event Object Details (`e.detail`) | Description |
| --- | --- | --- |
| `'connected'` | `{ type: 'serial'|'ble', ... }` | Fires immediately when a hardware connection handoff resolves. |
| `'disconnected'` | `{ type, unexpected: true|false }` | Fires on targeted closure or when an unprompted hardware disconnect occurs. |
| `'config-frequency'` | `{ hz, port }` | Triggered when the node reads out or verifies its operational frequency. |
| `'config-sf'` | `{ sf, port }` | Triggered when the node reports its active Spreading Factor. |

### Code Implementation Example

```javascript
rnode.addEventListener('decrypted-text', (e) => {
  const { text, port } = e.detail;
  appendMessageToChatWindow(`[Port ${port}] Secure Link: ${text}`);
});

rnode.addEventListener('plaintext', (e) => {
  appendMessageToChatWindow(`Public Broadcast: ${e.detail.text}`);
});

rnode.addEventListener('decryption-failed', () => {
  showNetworkAlertWarning("Encrypted packet dropped. Authentication token mismatch.");
});

rnode.addEventListener('disconnected', (e) => {
  if (e.detail.unexpected) {
    attemptAutomaticReconnectionRoutine();
  }
});

```

---

## 🛠️ Provisioning & Hardware Control

You can read or overwrite the transceiver configuration parameters at any point while the session interface is active.

```javascript
// Align the radio modem to match your target grid
await rnode.setFrequency(915000000);        // Set to 915 MHz (US ISM Band)
await rnode.setBandwidth(125000);          // Set to 125 kHz 
await rnode.setSpreadingFactor(7);         // Set to SF7 (Faster data transfer speed)
await rnode.setCodingRate(5);              // Set to CR 4/5 error protection bounds
await rnode.setTxPower(20);                // Max out transmission gain to +20 dBm

```

---

## 🔐 Security Context (AES-GCM Protocol Layout)

When utilizing `sendEncryptedText()`, the binary payload packed inside the over-the-air LoRa data space adheres to the following sequence layout before passing through the final TNC-facing KISS encapsulation wrapper:

```text
┌───────────────────────────────┬──────────────────────────────────────────────┐
│  Initialization Vector (IV)   │             Encrypted Ciphertext             │
│          (12 Bytes)           │               (Variable Length)              │
├───────────────────────────────┴──────────────────────────────────────────────┤
│ ◄─────────────────────────────── Encrypted Payload ────────────────────────► │
└──────────────────────────────────────────────────────────────────────────────┘

```

1. **Nonce Isolation:** The 12-byte initialization vector (IV) is cryptographically unique per packet, generated using the hardware-backed window entropy generator `crypto.getRandomValues()`.
2. **Symmetric Layer:** The ciphertext block contains an explicit, appended cryptographic authentication tag automatically verified by `crypto.subtle.decrypt()` before processing, protecting the node from replay and manipulation tactics.

---

## 📝 License

This project is open-source software licensed under the [MIT License](https://www.google.com/search?q=LICENSE).
