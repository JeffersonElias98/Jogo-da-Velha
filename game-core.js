(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JogoCore = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const X_MARK = 'x';
  const CIRCLE_MARK = 'circle';

  const WINNING_COMBINATIONS = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6]
  ];

  const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function generateRoomCode(length = 6) {
    let code = '';
    for (let i = 0; i < length; i++) {
      const idx = Math.floor(Math.random() * ROOM_ALPHABET.length);
      code += ROOM_ALPHABET[idx];
    }
    return code;
  }

  function generateClientId() {
    const rand = Math.random().toString(36).slice(2, 10);
    const ts = Date.now().toString(36).slice(-4);
    return `jv_${ts}_${rand}`;
  }

  function sanitizeName(name, fallback = 'Jogador') {
    if (typeof name !== 'string') return fallback;
    const cleaned = name.trim().replace(/\s+/g, ' ').slice(0, 20);
    return cleaned || fallback;
  }

  function normalizeRoomCode(input) {
    if (typeof input !== 'string') return null;
    let candidate = input.trim();
    if (!candidate) return null;

    if (candidate.includes('sala=')) {
      try {
        const url = candidate.startsWith('http')
          ? new URL(candidate)
          : new URL(candidate, 'https://example.local');
        const salaParam = url.searchParams.get('sala');
        if (salaParam) candidate = salaParam;
      } catch (_) {
        const match = candidate.match(/[?&]sala=([A-Za-z0-9_-]+)/);
        if (match) candidate = match[1];
      }
    }

    const normalized = candidate.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalized.length < 4 || normalized.length > 12) {
      return null;
    }
    return normalized;
  }

  function parseInviteParams(searchString) {
    const params = new URLSearchParams(searchString || '');
    const roomCode = normalizeRoomCode(params.get('sala') || '');
    const rawBroker = Number.parseInt(params.get('b') || '0', 10);
    const brokerIndex = Number.isInteger(rawBroker) && rawBroker >= 0 ? rawBroker : 0;
    return { roomCode, brokerIndex };
  }

  function buildInviteUrl(baseHref, roomCode, brokerIndex = 0) {
    const url = new URL(baseHref);
    url.search = '';
    url.hash = '';
    url.searchParams.set('sala', roomCode);
    if (brokerIndex > 0) {
      url.searchParams.set('b', String(brokerIndex));
    }
    return url.toString();
  }

  function evaluateBoard(board) {
    for (const combination of WINNING_COMBINATIONS) {
      const [a, b, c] = combination;
      const mark = board[a];
      if (mark && mark === board[b] && mark === board[c]) {
        return {
          status: 'win',
          winner: mark,
          winningLine: combination
        };
      }
    }

    const isFull = board.every(cell => cell === X_MARK || cell === CIRCLE_MARK);
    if (isFull) {
      return {
        status: 'draw',
        winner: null,
        winningLine: null
      };
    }

    return {
      status: 'playing',
      winner: null,
      winningLine: null
    };
  }

  function createLocalGameState() {
    return {
      board: Array(9).fill(null),
      circleTurn: false,
      status: 'playing',
      winner: null,
      winningLine: null,
      scores: {
        x: 0,
        circle: 0,
        draws: 0
      }
    };
  }

  function applyLocalMove(state, index) {
    if (state.status !== 'playing') {
      return { ok: false, reason: 'game_finished', state };
    }
    if (!Number.isInteger(index) || index < 0 || index > 8) {
      return { ok: false, reason: 'invalid_index', state };
    }
    if (state.board[index] !== null) {
      return { ok: false, reason: 'cell_occupied', state };
    }

    const currentMark = state.circleTurn ? CIRCLE_MARK : X_MARK;
    const nextBoard = state.board.slice();
    nextBoard[index] = currentMark;

    const evaluation = evaluateBoard(nextBoard);
    const nextScores = { ...state.scores };

    if (evaluation.status === 'win') {
      if (evaluation.winner === X_MARK) nextScores.x += 1;
      else nextScores.circle += 1;

      return {
        ok: true,
        state: {
          ...state,
          board: nextBoard,
          status: 'finished',
          winner: evaluation.winner,
          winningLine: evaluation.winningLine,
          scores: nextScores
        }
      };
    }

    if (evaluation.status === 'draw') {
      nextScores.draws += 1;
      return {
        ok: true,
        state: {
          ...state,
          board: nextBoard,
          status: 'finished',
          winner: null,
          winningLine: null,
          scores: nextScores
        }
      };
    }

    return {
      ok: true,
      state: {
        ...state,
        board: nextBoard,
        circleTurn: !state.circleTurn
      }
    };
  }

  function restartLocalRound(state) {
    return {
      ...state,
      board: Array(9).fill(null),
      circleTurn: false,
      status: 'playing',
      winner: null,
      winningLine: null
    };
  }

  function createHostRoomState({ roomCode, hostId, hostName }) {
    return {
      roomCode,
      round: 1,
      status: 'waiting',
      hostId,
      hostName: sanitizeName(hostName, 'Anfitrião'),
      guestId: null,
      guestName: 'Aguardando...',
      hostMark: X_MARK,
      guestMark: CIRCLE_MARK,
      board: Array(9).fill(null),
      circleTurn: false,
      starterIsCircle: false,
      winner: null,
      winningLine: null,
      scores: {
        x: 0,
        circle: 0,
        draws: 0
      },
      rematchReady: {}
    };
  }

  function handleJoinRequest(state, { clientId, name }) {
    if (!clientId || typeof clientId !== 'string') {
      return { accepted: false, reason: 'invalid_client', state };
    }
    if (clientId === state.hostId) {
      return { accepted: false, reason: 'same_as_host', state };
    }
    if (state.guestId && state.guestId !== clientId) {
      return { accepted: false, reason: 'room_full', state };
    }

    const isNewGuest = !state.guestId;
    const guestName = sanitizeName(name, 'Convidado');

    return {
      accepted: true,
      isNewGuest,
      state: {
        ...state,
        guestId: clientId,
        guestName,
        status: state.status === 'waiting' ? 'playing' : state.status
      }
    };
  }

  function handleGuestLeave(state, clientId) {
    if (!state.guestId || state.guestId !== clientId) {
      return { left: false, state };
    }

    return {
      left: true,
      state: {
        ...state,
        guestId: null,
        guestName: 'Aguardando...',
        status: 'waiting',
        board: Array(9).fill(null),
        circleTurn: state.starterIsCircle,
        winner: null,
        winningLine: null,
        rematchReady: {}
      }
    };
  }

  function getExpectedMark(state) {
    return state.circleTurn ? CIRCLE_MARK : X_MARK;
  }

  function getExpectedPlayerId(state) {
    const expectedMark = getExpectedMark(state);
    return expectedMark === state.hostMark ? state.hostId : state.guestId;
  }

  function handleOnlineMove(state, { clientId, index, round }) {
    if (state.status !== 'playing') {
      return { ok: false, reason: 'not_playing', state };
    }
    if (round !== state.round) {
      return { ok: false, reason: 'stale_round', state };
    }
    if (!Number.isInteger(index) || index < 0 || index > 8) {
      return { ok: false, reason: 'invalid_index', state };
    }
    if (state.board[index] !== null) {
      return { ok: false, reason: 'cell_occupied', state };
    }

    const expectedId = getExpectedPlayerId(state);
    if (!expectedId || clientId !== expectedId) {
      return { ok: false, reason: 'not_your_turn', state };
    }

    const mark = getExpectedMark(state);
    const nextBoard = state.board.slice();
    nextBoard[index] = mark;

    const evaluation = evaluateBoard(nextBoard);
    const nextScores = { ...state.scores };

    if (evaluation.status === 'win') {
      if (evaluation.winner === X_MARK) nextScores.x += 1;
      else nextScores.circle += 1;

      return {
        ok: true,
        state: {
          ...state,
          board: nextBoard,
          status: 'finished',
          winner: evaluation.winner,
          winningLine: evaluation.winningLine,
          scores: nextScores,
          rematchReady: {}
        }
      };
    }

    if (evaluation.status === 'draw') {
      nextScores.draws += 1;
      return {
        ok: true,
        state: {
          ...state,
          board: nextBoard,
          status: 'finished',
          winner: null,
          winningLine: null,
          scores: nextScores,
          rematchReady: {}
        }
      };
    }

    return {
      ok: true,
      state: {
        ...state,
        board: nextBoard,
        circleTurn: !state.circleTurn
      }
    };
  }

  function handleRematchRequest(state, { clientId, round }) {
    if (state.status !== 'finished') {
      return { ok: false, reason: 'not_finished', startedNewRound: false, state };
    }
    if (round !== state.round) {
      return { ok: false, reason: 'stale_round', startedNewRound: false, state };
    }
    if (clientId !== state.hostId && clientId !== state.guestId) {
      return { ok: false, reason: 'unauthorized', startedNewRound: false, state };
    }
    if (!state.guestId) {
      return { ok: false, reason: 'no_guest', startedNewRound: false, state };
    }

    const nextReady = {
      ...state.rematchReady,
      [clientId]: true
    };

    const bothReady = Boolean(nextReady[state.hostId] && nextReady[state.guestId]);

    if (bothReady) {
      const nextStarterIsCircle = !state.starterIsCircle;
      return {
        ok: true,
        startedNewRound: true,
        state: {
          ...state,
          round: state.round + 1,
          status: 'playing',
          board: Array(9).fill(null),
          starterIsCircle: nextStarterIsCircle,
          circleTurn: nextStarterIsCircle,
          winner: null,
          winningLine: null,
          rematchReady: {}
        }
      };
    }

    return {
      ok: true,
      startedNewRound: false,
      state: {
        ...state,
        rematchReady: nextReady
      }
    };
  }

  return {
    X_MARK,
    CIRCLE_MARK,
    WINNING_COMBINATIONS,
    generateRoomCode,
    generateClientId,
    sanitizeName,
    normalizeRoomCode,
    parseInviteParams,
    buildInviteUrl,
    evaluateBoard,
    createLocalGameState,
    applyLocalMove,
    restartLocalRound,
    createHostRoomState,
    handleJoinRequest,
    handleGuestLeave,
    getExpectedMark,
    getExpectedPlayerId,
    handleOnlineMove,
    handleRematchRequest
  };
}));
