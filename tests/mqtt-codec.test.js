const test = require('node:test');
const assert = require('node:assert/strict');
const { MiniMqttCodec } = require('../online.js');

test('MiniMqttCodec encodes CONNECT with LWT and decodes CONNACK', () => {
  const pkt = MiniMqttCodec.encodeConnect({
    clientId: 'jv_host_123',
    keepalive: 15,
    will: {
      topic: 'room/ABC123/events',
      payload: '{"type":"leave"}',
      qos: 1,
      retain: false
    }
  });

  assert.equal(pkt[0], 0x10);
  // Protocol name "MQTT" starts after fixed header
  const str = Buffer.from(pkt).toString('utf8');
  assert.ok(str.includes('MQTT'));
  assert.ok(str.includes('jv_host_123'));
  assert.ok(str.includes('room/ABC123/events'));
  assert.ok(str.includes('{"type":"leave"}'));

  const connack = new Uint8Array([0x20, 0x02, 0x00, 0x00]);
  const parsed = MiniMqttCodec.parsePackets(connack);
  assert.equal(parsed.packets.length, 1);
  assert.deepEqual(parsed.packets[0], { type: 'connack', returnCode: 0 });
  assert.equal(parsed.remaining.length, 0);
});

test('MiniMqttCodec encodes and parses QoS 1 PUBLISH across fragmented chunks', () => {
  const payloadObj = { type: 'move', index: 4, round: 1, clientId: 'guest_1' };
  const pub = MiniMqttCodec.encodePublish({
    topic: 'jogo-da-velha-jefferson/v1/rooms/K7M9P2/events',
    payload: JSON.stringify(payloadObj),
    qos: 1,
    packetId: 42
  });

  // Split packet in the middle to simulate TCP/WS fragmentation
  const part1 = pub.subarray(0, 15);
  const part2 = pub.subarray(15);

  const firstParse = MiniMqttCodec.parsePackets(part1);
  assert.equal(firstParse.packets.length, 0);
  assert.equal(firstParse.remaining.length, 15);

  const combined = new Uint8Array(firstParse.remaining.length + part2.length);
  combined.set(firstParse.remaining, 0);
  combined.set(part2, firstParse.remaining.length);

  const secondParse = MiniMqttCodec.parsePackets(combined);
  assert.equal(secondParse.packets.length, 1);
  assert.equal(secondParse.packets[0].type, 'publish');
  assert.equal(secondParse.packets[0].qos, 1);
  assert.equal(secondParse.packets[0].packetId, 42);
  assert.equal(secondParse.packets[0].topic, 'jogo-da-velha-jefferson/v1/rooms/K7M9P2/events');
  assert.deepEqual(JSON.parse(secondParse.packets[0].payload), payloadObj);
});

test('MiniMqttCodec encodes SUBSCRIBE, PUBACK, PINGREQ, DISCONNECT', () => {
  const sub = MiniMqttCodec.encodeSubscribe({ packetId: 7, topic: 'a/b', qos: 1 });
  assert.equal(sub[0], 0x82);

  const puback = MiniMqttCodec.encodePuback(42);
  assert.deepEqual(Array.from(puback), [0x40, 0x02, 0x00, 0x2a]);

  assert.deepEqual(Array.from(MiniMqttCodec.encodePingreq()), [0xc0, 0x00]);
  assert.deepEqual(Array.from(MiniMqttCodec.encodeDisconnect()), [0xe0, 0x00]);
});
