(function (root) {
  const BROKERS = [
    { name: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
    { name: 'HiveMQ', url: 'wss://broker.hivemq.com:8884/mqtt' }
  ];

  const TOPIC_PREFIX = 'jogo-da-velha-jefferson/v1/rooms';
  const CONNECT_TIMEOUT_MS = 5000;
  const HEARTBEAT_INTERVAL_MS = 6000;
  const PEER_TIMEOUT_MS = 22000;

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

      if (typeof root.mqtt === 'undefined' || typeof root.mqtt.connect !== 'function') {
        this.onError('Não foi possível carregar o cliente online. Verifique sua conexão com a internet.');
        return;
      }

      const broker = BROKERS[this.brokerIndex] || BROKERS[0];
      this.onStatus('connecting', { brokerIndex: this.brokerIndex, brokerName: broker.name });

      const mqttClientId = `${this.clientId}_${Math.random().toString(36).slice(2, 6)}`;

      const client = root.mqtt.connect(broker.url, {
        clientId: mqttClientId,
        clean: true,
        connectTimeout: CONNECT_TIMEOUT_MS,
        reconnectPeriod: 3000,
        keepalive: 15,
        will: {
          topic: this.eventsTopic,
          payload: JSON.stringify({
            type: 'leave',
            clientId: this.clientId,
            role: this.role
          }),
          qos: 1,
          retain: false
        }
      });

      this.client = client;

      clearTimeout(this.connectTimer);
      this.connectTimer = setTimeout(() => {
        if (this.closed || this.hasConnectedOnce) return;
        this._handleConnectFailure('Tempo esgotado ao conectar ao servidor.');
      }, CONNECT_TIMEOUT_MS + 500);

      client.on('connect', () => {
        if (this.closed || this.client !== client) return;
        clearTimeout(this.connectTimer);
        this.hasConnectedOnce = true;

        client.subscribe(this.eventsTopic, { qos: 1 }, err => {
          if (this.closed || this.client !== client) return;
          if (err) {
            this.onError('Erro ao entrar no canal da sala.');
            return;
          }
          this.startHeartbeat();
          this.onStatus('connected', { brokerIndex: this.brokerIndex, brokerName: broker.name });
        });
      });

      client.on('reconnect', () => {
        if (this.closed || this.client !== client) return;
        if (this.hasConnectedOnce) {
          this.onStatus('reconnecting', { brokerIndex: this.brokerIndex });
        }
      });

      client.on('offline', () => {
        if (this.closed || this.client !== client) return;
        if (this.hasConnectedOnce) {
          this.onStatus('reconnecting', { brokerIndex: this.brokerIndex });
        }
      });

      client.on('error', err => {
        if (this.closed || this.client !== client) return;
        if (!this.hasConnectedOnce) {
          this._handleConnectFailure(err && err.message ? err.message : 'Falha na conexão');
        }
      });

      client.on('message', (_topic, payloadBuffer) => {
        if (this.closed || this.client !== client) return;
        try {
          const text = typeof payloadBuffer === 'string'
            ? payloadBuffer
            : payloadBuffer.toString('utf8');
          const msg = JSON.parse(text);
          if (!msg || typeof msg !== 'object') return;
          if (msg.clientId === this.clientId) return;

          if (this.trackingPeer && msg.type !== 'leave') {
            this.lastPeerSeen = Date.now();
          }
          this.onMessage(msg);
        } catch (_) {
          // Ignore malformed payloads
        }
      });
    }

    _handleConnectFailure(reason) {
      clearTimeout(this.connectTimer);
      if (this.client) {
        try {
          this.client.end(true);
        } catch (_) {}
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
        this.client.publish(
          this.eventsTopic,
          JSON.stringify({
            ...payload,
            clientId: this.clientId,
            role: this.role
          }),
          { qos: 1 }
        );
        return true;
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
              { qos: 1 }
            );
          } catch (_) {}
        }
        try {
          this.client.end(true);
        } catch (_) {}
        this.client = null;
      }
    }
  }

  root.JogoOnline = {
    BROKERS,
    OnlineSession
  };
}(typeof globalThis !== 'undefined' ? globalThis : this));
