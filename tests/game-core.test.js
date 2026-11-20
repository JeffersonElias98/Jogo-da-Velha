const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../game-core.js');

test('room code generation and normalization', () => {
  const code = Core.generateRoomCode();
  assert.equal(code.length, 6);
  assert.match(code, /^[A-Z0-9]{6}$/);

  assert.equal(Core.normalizeRoomCode(' ab-12c '), 'AB12C');
  assert.equal(Core.normalizeRoomCode('https://example.com/jogo/?sala=k7m9p2&b=1'), 'K7M9P2');
  assert.equal(Core.normalizeRoomCode('?sala=x9y8z7'), 'X9Y8Z7');
  assert.equal(Core.normalizeRoomCode('ab'), null);
  assert.equal(Core.normalizeRoomCode(''), null);
});

test('invite url build and parse', () => {
  const url0 = Core.buildInviteUrl('https://jefferson.github.io/Jogo-da-Velha/', 'K7M9P2', 0);
  assert.equal(url0, 'https://jefferson.github.io/Jogo-da-Velha/?sala=K7M9P2');
  assert.deepEqual(Core.parseInviteParams(new URL(url0).search), {
    roomCode: 'K7M9P2',
    brokerIndex: 0
  });

  const url1 = Core.buildInviteUrl('https://jefferson.github.io/Jogo-da-Velha/?foo=bar#hash', 'K7M9P2', 1);
  assert.equal(url1, 'https://jefferson.github.io/Jogo-da-Velha/?sala=K7M9P2&b=1');
  assert.deepEqual(Core.parseInviteParams(new URL(url1).search), {
    roomCode: 'K7M9P2',
    brokerIndex: 1
  });
});

test('local game flow: win detection, score increment, and restart', () => {
  let state = Core.createLocalGameState();

  // X: 0, O: 3, X: 1, O: 4, X: 2 -> X wins top row [0, 1, 2]
  for (const idx of [0, 3, 1, 4, 2]) {
    const res = Core.applyLocalMove(state, idx);
    assert.equal(res.ok, true);
    state = res.state;
  }

  assert.equal(state.status, 'finished');
  assert.equal(state.winner, Core.X_MARK);
  assert.deepEqual(state.winningLine, [0, 1, 2]);
  assert.deepEqual(state.scores, { x: 1, circle: 0, draws: 0 });

  // Further moves rejected until restart
  const afterWin = Core.applyLocalMove(state, 5);
  assert.equal(afterWin.ok, false);
  assert.equal(afterWin.reason, 'game_finished');

  state = Core.restartLocalRound(state);
  assert.equal(state.status, 'playing');
  assert.equal(state.circleTurn, false);
  assert.deepEqual(state.scores, { x: 1, circle: 0, draws: 0 });
});

test('local game flow: draw detection', () => {
  let state = Core.createLocalGameState();
  // Board resulting in draw:
  // X O X
  // X O O
  // O X X
  const moves = [0, 1, 2, 4, 3, 5, 7, 6, 8];
  for (const idx of moves) {
    const res = Core.applyLocalMove(state, idx);
    assert.equal(res.ok, true);
    state = res.state;
  }

  assert.equal(state.status, 'finished');
  assert.equal(state.winner, null);
  assert.equal(state.winningLine, null);
  assert.deepEqual(state.scores, { x: 0, circle: 0, draws: 1 });
});

test('online host room: join, room full, turn enforcement, win, and mutual rematch', () => {
  let room = Core.createHostRoomState({
    roomCode: 'ABC123',
    hostId: 'host_1',
    hostName: 'Jefferson'
  });
  assert.equal(room.status, 'waiting');

  // Guest joins
  const join1 = Core.handleJoinRequest(room, { clientId: 'guest_1', name: 'Maria' });
  assert.equal(join1.accepted, true);
  assert.equal(join1.isNewGuest, true);
  room = join1.state;
  assert.equal(room.status, 'playing');
  assert.equal(room.guestName, 'Maria');

  // 3rd player rejected
  const join2 = Core.handleJoinRequest(room, { clientId: 'intruder', name: 'Bob' });
  assert.equal(join2.accepted, false);
  assert.equal(join2.reason, 'room_full');

  // Same guest reconnecting is accepted
  const rejoin = Core.handleJoinRequest(room, { clientId: 'guest_1', name: 'Maria' });
  assert.equal(rejoin.accepted, true);
  assert.equal(rejoin.isNewGuest, false);

  // Guest tries to play out of turn (X goes first = host_1)
  const badTurn = Core.handleOnlineMove(room, { clientId: 'guest_1', index: 0, round: 1 });
  assert.equal(badTurn.ok, false);
  assert.equal(badTurn.reason, 'not_your_turn');

  // Play to O (guest) victory:
  // X(0), O(4), X(1), O(2), X(8), O(6) -> O wins [2, 4, 6]
  const sequence = [
    { clientId: 'host_1', index: 0 },
    { clientId: 'guest_1', index: 4 },
    { clientId: 'host_1', index: 1 },
    { clientId: 'guest_1', index: 2 },
    { clientId: 'host_1', index: 8 },
    { clientId: 'guest_1', index: 6 }
  ];
  for (const step of sequence) {
    const res = Core.handleOnlineMove(room, { ...step, round: 1 });
    assert.equal(res.ok, true);
    room = res.state;
  }

  assert.equal(room.status, 'finished');
  assert.equal(room.winner, Core.CIRCLE_MARK);
  assert.deepEqual(room.winningLine, [2, 4, 6]);
  assert.deepEqual(room.scores, { x: 0, circle: 1, draws: 0 });

  // Rematch requires both players; second round alternates starter to O (guest_1)
  const rem1 = Core.handleRematchRequest(room, { clientId: 'guest_1', round: 1 });
  assert.equal(rem1.ok, true);
  assert.equal(rem1.startedNewRound, false);
  room = rem1.state;

  const rem2 = Core.handleRematchRequest(room, { clientId: 'host_1', round: 1 });
  assert.equal(rem2.ok, true);
  assert.equal(rem2.startedNewRound, true);
  room = rem2.state;

  assert.equal(room.round, 2);
  assert.equal(room.status, 'playing');
  assert.equal(room.circleTurn, true);
  assert.equal(Core.getExpectedPlayerId(room), 'guest_1');
});

test('online host room: guest leaving resets board to waiting', () => {
  let room = Core.createHostRoomState({
    roomCode: 'XYZ789',
    hostId: 'host_1',
    hostName: 'Host'
  });
  room = Core.handleJoinRequest(room, { clientId: 'guest_1', name: 'Guest' }).state;
  room = Core.handleOnlineMove(room, { clientId: 'host_1', index: 0, round: 1 }).state;

  const leave = Core.handleGuestLeave(room, 'guest_1');
  assert.equal(leave.left, true);
  room = leave.state;
  assert.equal(room.status, 'waiting');
  assert.equal(room.guestId, null);
  assert.deepEqual(room.board, Array(9).fill(null));
});
