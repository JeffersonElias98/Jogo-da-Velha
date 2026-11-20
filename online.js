(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
  } else {
    root.JogoOnline = factory(root);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const BROKERS = [
    { name: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
    { name: 'HiveMQ', url: 'wss://broker.hivemq.com:8884/mqtt' },
    { name: 'Mosquitto', url: 'wss://test.mosquitto.org:8081/mqtt' }
  ];

  const TOPIC_PREFIX = 'jogo-da-velha-jefferson/v1/rooms';
  const CONNECT_TIMEOUT_MS = 4500;
  const HEARTBEAT_INTERVAL_MS = 6000;
  const PEER_TIMEOUT_MS = 22000;
  const KEEPALIVE_SECONDS = 15;

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  function encodeRemainingLength(len) {
    const bytes = [];
    let remaining = len;
    do {
      let digit = remaining % 128;
      remaining = Math.floor(remaining / 128);
      if (remaining > 0) digit |= 128;
      bytes.push(digit);
    } while (remaining > 0);
    return bytes;
  }

  function decodeRemainingLength(buf, offset) {
    let multiplier = 1;
    let value = 0;
    let pos = offset;
    while (pos < buf.length) {
      const encodedByte = buf[pos++];
      value += (encodedByte & 127) * multiplier;
      if ((encodedByte & 128) === 0) {
        return { length: value, nextOffset: pos };
      }
      multiplier *= 128;
      if (multiplier > 128 * 128 * 128) {
        throw new Error('Malformed MQTT remaining length');
      }
    }
    return null;
  }

  function encodeMqttString(str) {
    const utf8 = textEncoder.encode(str);
    const out = new Uint8Array(2 + utf8.length);
    out[0] = (utf8.length >> 8) & 0xff;
    out[1] = utf8.length & 0xff;
    out.set(utf8, 2);
    return out;
  }

  function concatUint8Arrays(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  function buildPacket(headerByte, bodyBytes) {
    const rem = encodeRemainingLength(bodyBytes.length);
    const out = new Uint8Array(1 + rem.length + bodyBytes.length);
    out[0] = headerByte;
    out.set(rem, 1);
    out.set(bodyBytes, 1 + rem.length);
    return out;
  }

  const MiniMqttCodec = {
    encodeConnect({ clientId, keepalive = KEEPALIVE_SECONDS, will = null }) {
      let connectFlags = 0x02; // Clean Session
      const payloadParts = [encodeMqttString(clientId)];

      if (will && will.topic) {
        const willQos = (will.qos || 0) & 0x03;
        connectFlags |= 0x04 | (willQos << 3) | (will.retain ? 0x20 : 0);
        payloadParts.push(encodeMqttString(will.topic));
        payloadParts.push(encodeMqttString(will.payload || ''));
      }

      const variableHeader = new Uint8Array([
        0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, // "MQTT"
        0x04, // Protocol level 4 (MQTT 3.1.1)
        connectFlags,
        (keepalive >> 8) & 0xff,
        keepalive & 0xff
      ]);

      return buildPacket(0x10, concatUint8Arrays([variableHeader, ...payloadParts]));
    },

    encodeSubscribe({ packetId, topic, qos = 1 }) {
      const header = new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]);
      const topicPart = encodeMqttString(topic);
      const qosPart = new Uint8Array([qos & 0x03]);
      return buildPacket(0x82, concatUint8Arrays([header, topicPart, qosPart]));
    },

    encodePublish({ topic, payload, qos = 0, packetId = 1 }) {
      const topicPart = encodeMqttString(topic);
      const payloadBytes = textEncoder.encode(payload);
      const parts = [topicPart];
      if (qos > 0) {
        parts.push(new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]));
      }
      parts.push(payloadBytes);
      const headerByte = 0x30 | ((qos & 0x03) << 1);
      return buildPacket(headerByte, concatUint8Arrays(parts));
    },

    encodePuback(packetId) {
      return new Uint8Array([0x40, 0x02, (packetId >> 8) & 0xff, packetId & 0xff]);
    },

    encodePingreq() {
      return new Uint8Array([0xc0, 0x00]);
    },

    encodeDisconnect() {
      return new Uint8Array([0xe0, 0x00]);
    },

    parsePackets(buffer) {
      const packets = [];
      let buf = buffer;

      while (buf.length >= 2) {
        const headerByte = buf[0];
        const packetType = headerByte >> 4;
        const flags = headerByte & 0x0f;

        const rem = decodeRemainingLength(buf, 1);
        if (!rem) break;

        const packetEnd = rem.nextOffset + rem.length;
        if (buf.length < packetEnd) break;

        const body = buf.subarray(rem.nextOffset, packetEnd);
        buf = buf.subarray(packetEnd);

        if (packetType === 2 && body.length >= 2) {
          packets.push({ type: 'connack', returnCode: body[1] });
        } else if (packetType === 3 && body.length >= 2) {
          const qos = (flags >> 1) & 0x03;
          const topicLen = (body[0] << 8) | body[1];
          let pos = 2;
          const topic = textDecoder.decode(body.subarray(pos, pos + topicLen));
          pos += topicLen;
          let packetId = null;
          if (qos > 0 && pos + 2 <= body.length) {
            packetId = (body[pos] << 8) | body[pos + 1];
            pos += 2;
          }
          const payload = textDecoder.decode(body.subarray(pos));
          packets.push({ type: 'publish', qos, packetId, topic, payload });
        } else if (packetType === 9 && body.length >= 2) {
          const packetId = (body[0] << 8) | body[1];
          packets.push({ type: 'suback', packetId });
        } else if (packetType === 13) {
          packets.push({ type: 'pingresp' });
        } else if (packetType === 4) {
          packets.push({ type: 'puback' });
        }
      }

      return { packets, remaining: buf };
    }
  };

  class MiniMqttClient {
    constructor(url, options) {
      this.url = url;
      this.clientId = options.clientId;
      this.will = options.will || null;
      this.onConnect = options.onConnect || (() => {});
      this.onMessage = options.onMessage || (() => {});
      this.onClose = options.onClose || (() => {});
      this.onError = options.onError || (() => {});

      this.ws = null;
      this.connected = false;
      this.closed = false;
      this.rxBuf = new Uint8Array(0);
      this.nextPacketId = 1;
      this.pendingSubs = new Map();
      this.pingTimer = null;
    }

    connect() {
      if (this.closed) return;
      const WS = root.WebSocket;
      if (typeof WS !== 'function') {
        this.onError(new Error('WebSocket indisponível neste navegador'));
        return;
      }

      try {
        this.ws = new WS(this.url, 'mqtt');
        this.ws.binaryType = 'arraybuffer';
      } catch (err) {
        this.onError(err);
        return;
      }

      this.ws.onopen = () => {
        if (this.closed) return;
        const pkt = MiniMqttCodec.encodeConnect({
          clientId: this.clientId,
          keepalive: KEEPALIVE_SECONDS,
          will: this.will
        });
        this._sendBytes(pkt);
      };

      this.ws.onmessage = event => {
        if (this.closed) return;
        const chunk = new Uint8Array(event.data);
        this.rxBuf = concatUint8Arrays([this.rxBuf, chunk]);

        try {
          const parsed = MiniMqttCodec.parsePackets(this.rxBuf);
          this.rxBuf = parsed.remaining;

          for (const pkt of parsed.packets) {
            if (pkt.type === 'connack') {
              if (pkt.returnCode === 0) {
                this.connected = true;
                this._startKeepalive();
                this.onConnect();
              } else {
                this.onError(new Error(`MQTT CONNACK code ${pkt.returnCode}`));
              }
            } else if (pkt.type === 'suback') {
              const cb = this.pendingSubs.get(pkt.packetId);
              if (cb) {
                this.pendingSubs.delete(pkt.packetId);
                cb(null);
              }
            } else if (pkt.type === 'publish') {
              if (pkt.qos === 1 && pkt.packetId !== null) {
                this._sendBytes(MiniMqttCodec.encodePuback(pkt.packetId));
              }
              this.onMessage(pkt.topic, pkt.payload);
            }
          }
        } catch (err) {
          this.onError(err);
        }
      };

      this.ws.onerror = () => {
        if (this.closed) return;
        this.onError(new Error('Falha na conexão WebSocket'));
      };

      this.ws.onclose = () => {
        const wasConnected = this.connected;
        this.connected = false;
        this._stopKeepalive();
        if (!this.closed) {
          this.onClose(wasConnected);
        }
      };
    }

    _nextId() {
      const id = this.nextPacketId;
      this.nextPacketId = id >= 65535 ? 1 : id + 1;
      return id;
    }

    _sendBytes(bytes) {
      if (!this.ws || this.ws.readyState !== 1) return false;
      this.ws.send(bytes);
      return true;
    }

    _startKeepalive() {
      this._stopKeepalive();
      this.pingTimer = setInterval(() => {
        if (!this.closed && this.connected) {
          this._sendBytes(MiniMqttCodec.encodePingreq());
        }
      }, 10000);
    }

    _stopKeepalive() {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    subscribe(topic, cb) {
      if (!this.connected) {
        if (cb) cb(new Error('Não conectado'));
        return;
      }
      const packetId = this._nextId();
      if (cb) this.pendingSubs.set(packetId, cb);
      this._sendBytes(MiniMqttCodec.encodeSubscribe({ packetId, topic, qos: 1 }));
    }

    publish(topic, payload, qos = 1) {
      if (!this.connected) return false;
      const packetId = qos > 0 ? this._nextId() : 0;
      return this._sendBytes(MiniMqttCodec.encodePublish({ topic, payload, qos, packetId }));
    }

    close(sendDisconnect = true) {
      if (this.closed) return;
      this.closed = true;
      this.connected = false;
      this._stopKeepalive();
      this.pendingSubs.clear();
      if (this.ws) {
        if (sendDisconnect && this.ws.readyState === 1) {
          try {
            this.ws.send(MiniMqttCodec.encodeDisconnect());
          } catch (_) {}
        }
        try {
          this.ws.close();
        } catch (_) {}
        this.ws = null;
      }
    }
  }

  class OnlineSession {
    constructor(options) {
      this.roomCode = options.roomCode;
      this.role = options.role; // 'host' | 'guest'
      this.clientId = options.clientId;
      this.playerName = options.playerName;
      this.brokerIndex = Number.isInteger(options.brokerIndex) ? options.brokerIndex : 0;
      this.allowFailover = options.role === 'host';

      this.onStatus = options.onStatus || (() => {});
      this.onMessage = options.onMessage || (() => {});
      this.onError = options.onError || (() => {});
      this.onPeerTimeout = options.onPeerTimeout || (() => {});

      this.client = null;
      this.closed = false;
      this.hasConnectedOnce = false;
      this.connectTimer = null;
      this.reconnectTimer = null;
      this.heartbeatTimer = null;
      this.peerWatchTimer = null;
      this.lastPeerSeen = 0;
      this.trackingPeer = false;
    }

    get eventsTopic() {
      return `${TOPIC_PREFIX}/${this.roomCode}/events`;
    }

    connect() {
      if (this.closed) return;

      const broker = BROKERS[this.brokerIndex] || BROKERS[0];
      this.onStatus('connecting', { brokerIndex: this.brokerIndex, brokerName: broker.name });

      const mqttClientId = `${this.clientId}_${Math.random().toString(36).slice(2, 6)}`;
      let failedThisAttempt = false;

      const failAttempt = reason => {
        if (failedThisAttempt || this.closed) return;
        failedThisAttempt = true;
        this._handleConnectFailure(reason);
      };

      const client = new MiniMqttClient(broker.url, {
        clientId: mqttClientId,
        will: {
          topic: this.eventsTopic,
          payload: JSON.stringify({
            type: 'leave',
            clientId: this.clientId,
            role: this.role
          }),
          qos: 1,
          retain: false
        },
        onConnect: () => {
          if (this.closed || this.client !== client) return;
          clearTimeout(this.connectTimer);
          this.hasConnectedOnce = true;

          client.subscribe(this.eventsTopic, err => {
            if (this.closed || this.client !== client) return;
            if (err) {
              this.onError('Erro ao entrar no canal da sala.');
              return;
            }
            this.startHeartbeat();
            this.onStatus('connected', { brokerIndex: this.brokerIndex, brokerName: broker.name });
          });
        },
        onMessage: (_topic, payloadText) => {
          if (this.closed || this.client !== client) return;
          try {
            const msg = JSON.parse(payloadText);
            if (!msg || typeof msg !== 'object') return;
            if (msg.clientId === this.clientId) return;

            if (this.trackingPeer && msg.type !== 'leave') {
              this.lastPeerSeen = Date.now();
            }
            this.onMessage(msg);
          } catch (_) {}
        },
        onClose: wasConnected => {
          if (this.closed || this.client !== client) return;
          if (!this.hasConnectedOnce && !wasConnected) {
            failAttempt('Conexão fechada antes de confirmar');
            return;
          }
          this.stopHeartbeat();
          this.onStatus('reconnecting', { brokerIndex: this.brokerIndex });
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            if (!this.closed) this.connect();
          }, 2500);
        },
        onError: err => {
          if (this.closed || this.client !== client) return;
          if (!this.hasConnectedOnce) {
            failAttempt(err && err.message ? err.message : 'Falha na conexão');
          }
        }
      });

      this.client = client;

      clearTimeout(this.connectTimer);
      this.connectTimer = setTimeout(() => {
        if (this.closed || client.connected) return;
        failAttempt('Tempo esgotado');
      }, CONNECT_TIMEOUT_MS);

      client.connect();
    }

    _handleConnectFailure(reason) {
      clearTimeout(this.connectTimer);
      if (this.client) {
        this.client.close(false);
        this.client = null;
      }

      if (this.allowFailover && this.brokerIndex + 1 < BROKERS.length) {
        this.brokerIndex += 1;
        this.connect();
        return;
      }

      this.onError(`Não foi possível conectar ao modo online (${reason}).`);
    }

    send(payload) {
      if (this.closed || !this.client || !this.client.connected) return false;
      try {
        return this.client.publish(
          this.eventsTopic,
          JSON.stringify({
            ...payload,
            clientId: this.clientId,
            role: this.role
          }),
          1
        );
      } catch (_) {
        return false;
      }
    }

    setTrackingPeer(active) {
      this.trackingPeer = active;
      if (active) {
        this.lastPeerSeen = Date.now();
      }
    }

    startHeartbeat() {
      this.stopHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (this.closed) return;
        this.send({ type: 'ping' });
      }, HEARTBEAT_INTERVAL_MS);

      this.peerWatchTimer = setInterval(() => {
        if (this.closed || !this.trackingPeer || !this.lastPeerSeen) return;
        if (Date.now() - this.lastPeerSeen > PEER_TIMEOUT_MS) {
          this.trackingPeer = false;
          this.onPeerTimeout();
        }
      }, 3000);
    }

    stopHeartbeat() {
      clearInterval(this.heartbeatTimer);
      clearInterval(this.peerWatchTimer);
      this.heartbeatTimer = null;
      this.peerWatchTimer = null;
    }

    disconnect(sendLeave = true) {
      if (this.closed) return;
      this.closed = true;
      this.trackingPeer = false;
      clearTimeout(this.connectTimer);
      clearTimeout(this.reconnectTimer);
      this.stopHeartbeat();

      if (this.client) {
        if (sendLeave && this.client.connected) {
          try {
            this.client.publish(
              this.eventsTopic,
              JSON.stringify({
                type: 'leave',
                clientId: this.clientId,
                role: this.role
              }),
              1
            );
          } catch (_) {}
        }
        this.client.close(true);
        this.client = null;
      }
    }
  }

  return {
    BROKERS,
    MiniMqttCodec,
    MiniMqttClient,
    OnlineSession
  };
}));
