/**
 * UDP Audio Server for xiaozhi-esp32 MQTT+UDP hybrid protocol.
 *
 * Firmware packet layout (16-byte header ‖ encrypted payload):
 *   nonce[0-1]  | payload_len 2u BE | nonce[4-7] | timestamp 4u BE | sequence 4u BE
 *
 * The 16-byte header IS the AES-CTR IV (nonce with len/ts/seq baked in).
 */

import dgram from "node:dgram";
import { createDecipheriv, createCipheriv } from "node:crypto";
import { ingestUdpAudioFrame } from "@/services/xiaozhi/converse";

const HEADER_SIZE = 16;

interface ClientState {
  clientId: string;
  key: Buffer;
  sequence: number;
  timestamp: number;
  lastActivity: number;
  totalPackets: number;
}

declare global {
  var __udpServer: dgram.Socket | undefined;
  var __udpClients: Map<string, ClientState> | undefined;
  var __udpPendingKeys: Map<string, string> | undefined;
}

function getClients(): Map<string, ClientState> {
  if (!globalThis.__udpClients) globalThis.__udpClients = new Map();
  return globalThis.__udpClients;
}

function getPendingKeys(): Map<string, string> {
  if (!globalThis.__udpPendingKeys) globalThis.__udpPendingKeys = new Map();
  return globalThis.__udpPendingKeys;
}

function decryptAudio(data: Buffer, client: ClientState): Buffer | null {
  if (data.length < HEADER_SIZE) {
    console.warn(`[UDP] packet too short: ${data.length} < ${HEADER_SIZE}`);
    return null;
  }

  const payloadLen = data.readUInt16BE(2);
  if (data.length !== HEADER_SIZE + payloadLen) {
    console.warn(`[UDP] size mismatch: total=${data.length} payload_len=${payloadLen}`);
    return null;
  }

  const headerIv = data.subarray(0, 16);
  const encrypted = data.subarray(HEADER_SIZE);

  try {
    const decipher = createDecipheriv("aes-128-ctr", client.key, headerIv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (err) {
    console.warn(`[UDP] decrypt failed for ${client.clientId}: ${(err as Error).message}`);
    return null;
  }
}

function encryptAudio(payload: Buffer, client: ClientState, timestamp: number): Buffer {
  const seq = ++client.sequence;
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt8(0x01, 0);
  header.writeUInt16BE(payload.length, 2);
  header.writeUInt32BE(0, 4);
  header.writeUInt32BE(timestamp, 8);
  header.writeUInt32BE(seq, 12);

  const cipher = createCipheriv("aes-128-ctr", client.key, header);
  return Buffer.concat([header, cipher.update(payload), cipher.final()]);
}

function handlePacket(data: Buffer, rinfo: dgram.RemoteInfo): void {
  const sockKey = `${rinfo.address}:${rinfo.port}`;
  const clients = getClients();

  let client = clients.get(sockKey);

  if (!client) {
    const pendingKeys = getPendingKeys();
    let matchedClientId: string | undefined;
    let matchedAesKey: string | undefined;

    for (const [hexKey, clientId] of pendingKeys) {
      matchedClientId = clientId;
      matchedAesKey = hexKey;
      pendingKeys.delete(hexKey);
      break;
    }

    if (!matchedClientId || !matchedAesKey) {
      console.warn(`[UDP] unknown client ${sockKey}, no pending key, dropping ${data.length}B`);
      return;
    }

    if (data.length < HEADER_SIZE) return;

    const payloadLen = data.readUInt16BE(2);
    if (data.length !== HEADER_SIZE + payloadLen) return;

  client = {
    clientId: matchedClientId,
    key: Buffer.from(matchedAesKey, "hex"),
    sequence: 0,
    timestamp: 0,
    lastActivity: Date.now(),
    totalPackets: 0,
  };
    clients.set(sockKey, client);
    console.log(`[UDP] auto-registered ${matchedClientId} at ${sockKey}`);
  }

  const decrypted = decryptAudio(data, client);
  if (!decrypted) {
    console.warn(`[UDP] decrypt failed for ${client?.clientId ?? sockKey} (${data.length}B)`);
    return;
  }

  client.lastActivity = Date.now();
  client.totalPackets++;

  ingestUdpAudioFrame(client.clientId, decrypted);
}

function cleanupStaleClients(): void {
  const clients = getClients();
  const now = Date.now();
  for (const [key, client] of clients) {
    if (now - client.lastActivity > 120_000) {
      console.log(`[UDP] removing stale client ${client.clientId} (${client.totalPackets} packets)`);
      clients.delete(key);
    }
  }
}

export function registerUdpClientPre(clientId: string, hexKey: string): void {
  getPendingKeys().set(hexKey, clientId);
  console.log(`[UDP] pre-registered key for ${clientId}`);
}

export function hasUdpClient(clientId: string): boolean {
  for (const client of getClients().values()) {
    if (client.clientId === clientId) return true;
  }
  for (const cid of getPendingKeys().values()) {
    if (cid === clientId) return true;
  }
  return false;
}

export function resetUdpClient(clientId: string): void {
  const clients = getClients();
  for (const [sockKey, client] of [...clients]) {
    if (client.clientId === clientId) {
      clients.delete(sockKey);
    }
  }
  const pending = getPendingKeys();
  for (const [hexKey, cid] of [...pending]) {
    if (cid === clientId) {
      pending.delete(hexKey);
    }
  }
}

export async function sendAudioToClient(
  clientId: string,
  opusPayload: Buffer,
): Promise<void> {
  const socket = globalThis.__udpServer;
  if (!socket) return;

  const clients = getClients();
  let targetClient: ClientState | undefined;
  let sockKey: string | undefined;

  for (const [key, client] of clients) {
    if (client.clientId === clientId) {
      targetClient = client;
      sockKey = key;
      break;
    }
  }

  if (!targetClient || !sockKey) {
    console.warn(`[UDP] no connected client for ${clientId}`);
    return;
  }

  targetClient.timestamp = (targetClient.timestamp + 60) >>> 0;
  const encrypted = encryptAudio(opusPayload, targetClient, targetClient.timestamp);
  const [addr, portStr] = sockKey.split(":");
  const port = parseInt(portStr, 10);

  return new Promise<void>((resolve) => {
    socket.send(encrypted, 0, encrypted.length, port, addr, (err) => {
      if (err) console.error(`[UDP] send to ${clientId} failed: ${err.message}`);
      resolve();
    });
  });
}

let cleanupInterval: ReturnType<typeof setInterval> | undefined;

export function startUdpServer(port = 18888, host = "0.0.0.0"): Promise<void> {
  return new Promise((resolve) => {
    if (globalThis.__udpServer) {
      console.log("[UDP] server already running");
      resolve();
      return;
    }

    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

    socket.on("error", (err) => {
      console.error(`[UDP] socket error: ${err.message}`);
    });

    socket.on("message", (data, rinfo) => {
      handlePacket(data, rinfo);
    });

    socket.on("listening", () => {
      const addr = socket.address();
      console.log(`[UDP] listening on ${addr.address}:${addr.port}`);
      globalThis.__udpServer = socket;
      globalThis.__udpClients = new Map();
      globalThis.__udpPendingKeys = new Map();
      cleanupInterval = setInterval(cleanupStaleClients, 30_000);
      resolve();
    });

    socket.bind(port, host);
  });
}

export function stopUdpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = undefined;
    }

    const socket = globalThis.__udpServer;
    if (!socket) {
      resolve();
      return;
    }

    socket.close(() => {
      globalThis.__udpServer = undefined;
      globalThis.__udpClients = undefined;
      globalThis.__udpPendingKeys = undefined;
      console.log("[UDP] server stopped");
      resolve();
    });
  });
}
