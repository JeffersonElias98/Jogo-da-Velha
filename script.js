(function () {
  const Core = window.JogoCore;
  const { OnlineSession, BROKERS } = window.JogoOnline;

  const THEME_STORAGE_KEY = 'jv_theme';
  const NAME_STORAGE_KEY = 'jv_player_name';
  const ROOM_SESSION_KEY = 'jv_active_room';

  // DOM Elements
  const themeToggle = document.getElementById('themeToggle');
  const themeIcon = document.getElementById('themeIcon');
  const modeLocalBtn = document.getElementById('modeLocalBtn');
  const modeOnlineBtn = document.getElementById('modeOnlineBtn');

  const onlinePanel = document.getElementById('onlinePanel');
  const onlineLobby = document.getElementById('onlineLobby');
  const onlineRoom = document.getElementById('onlineRoom');
  const playerNameInput = document.getElementById('playerNameInput');
  const createRoomBtn = document.getElementById('createRoomBtn');
  const joinRoomForm = document.getElementById('joinRoomForm');
  const roomCodeInput = document.getElementById('roomCodeInput');

  const connectionDot = document.getElementById('connectionDot');
  const connectionStatusText = document.getElementById('connectionStatusText');
  const roomCodeBadge = document.getElementById('roomCodeBadge');
  const inviteBox = document.getElementById('inviteBox');
  const inviteLinkInput = document.getElementById('inviteLinkInput');
  const copyInviteBtn = document.getElementById('copyInviteBtn');
  const shareInviteBtn = document.getElementById('shareInviteBtn');
  const retryConnectBtn = document.getElementById('retryConnectBtn');
  const leaveRoomBtn = document.getElementById('leaveRoomBtn');

  const gameArea = document.getElementById('gameArea');
  const playerXCard = document.getElementById('playerXCard');
  const playerOCard = document.getElementById('playerOCard');
  const labelPlayerX = document.getElementById('labelPlayerX');
  const labelPlayerO = document.getElementById('labelPlayerO');
  const scoreXEl = document.getElementById('scoreX');
  const scoreDrawsEl = document.getElementById('scoreDraws');
  const scoreOEl = document.getElementById('scoreO');
  const statusBanner = document.getElementById('statusBanner');

  const boardEl = document.getElementById('board');
  const cellElements = Array.from(document.querySelectorAll('[data-cell]'));
  const localRestartBtn = document.getElementById('localRestartBtn');
  const localResetScoreBtn = document.getElementById('localResetScoreBtn');
  const inlineRematchBtn = document.getElementById('inlineRematchBtn');

  const winningMessageEl = document.getElementById('winningMessage');
  const winningTextEl = document.querySelector('[data-winning-message-text]');
  const winningSubtextEl = document.getElementById('winningSubtext');
  const restartButton = document.getElementById('restartButton');
  const closeOverlayBtn = document.getElementById('closeOverlayBtn');
  const toastEl = document.getElementById('toast');

  // App State
  let currentMode = 'local'; // 'local' | 'online'
  let localState = Core.createLocalGameState();

  let onlineSession = null;
  let onlineRole = null; // 'host' | 'guest'
  let myClientId = null;
  let activeRoomCode = null;
  let activeBrokerIndex = 0;
  let onlineRoomState = null;
  let hostDisconnected = false;
  let pendingGuestMove = false;
  let joinRetryTimer = null;
  let joinAttempts = 0;
  let overlayDismissedForRound = null;
  let overlayTimer = null;
  let toastTimer = null;

  init();

  function init() {
    initTheme();
    initPlayerName();
    bindEvents();

    if (typeof navigator.share === 'function') {
      shareInviteBtn.hidden = false;
    }

    const { roomCode, brokerIndex } = Core.parseInviteParams(window.location.search);
    const savedSession = readRoomSession();

    if (roomCode) {
      setMode('online', { clearUrl: false });
      if (savedSession && savedSession.roomCode === roomCode && savedSession.clientId) {
        if (savedSession.role === 'host' && savedSession.roomState) {
          resumeHostRoom(savedSession);
        } else {
          joinOnlineRoom(roomCode, brokerIndex, savedSession.clientId);
        }
      } else {
        joinOnlineRoom(roomCode, brokerIndex);
      }
    } else {
      setMode('local', { clearUrl: false });
    }
  }

  function initTheme() {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const useDark = savedTheme ? savedTheme === 'dark' : prefersDark;
    applyTheme(useDark);
  }

  function applyTheme(isDark) {
    document.body.classList.toggle('dark-mode', isDark);
    themeIcon.textContent = isDark ? '☀️' : '🌙';
  }

  function initPlayerName() {
    const savedName = localStorage.getItem(NAME_STORAGE_KEY);
    if (savedName) {
      playerNameInput.value = savedName;
    }
  }

  function getPlayerName(fallback) {
    return Core.sanitizeName(playerNameInput.value, fallback);
  }

  function bindEvents() {
    themeToggle.addEventListener('click', () => {
      const nextDark = !document.body.classList.contains('dark-mode');
      applyTheme(nextDark);
      localStorage.setItem(THEME_STORAGE_KEY, nextDark ? 'dark' : 'light');
    });

    playerNameInput.addEventListener('input', () => {
      localStorage.setItem(NAME_STORAGE_KEY, playerNameInput.value.trim().slice(0, 20));
    });

    modeLocalBtn.addEventListener('click', () => {
      if (currentMode === 'local') return;
      leaveOnlineRoom({ switchToLocal: true });
    });

    modeOnlineBtn.addEventListener('click', () => {
      if (currentMode === 'online') return;
      setMode('online', { clearUrl: false });
    });

    createRoomBtn.addEventListener('click', () => {
      createOnlineRoom();
    });

    joinRoomForm.addEventListener('submit', e => {
      e.preventDefault();
      const parsed = parseRoomInput(roomCodeInput.value);
      if (!parsed.roomCode) {
        showToast('Código ou link de sala inválido.');
        roomCodeInput.focus();
        return;
      }
      joinOnlineRoom(parsed.roomCode, parsed.brokerIndex);
    });

    copyInviteBtn.addEventListener('click', copyInviteLink);
    shareInviteBtn.addEventListener('click', shareInviteLink);
    inviteLinkInput.addEventListener('click', () => inviteLinkInput.select());

    retryConnectBtn.addEventListener('click', () => {
      if (!activeRoomCode) return;
      if (onlineRole === 'host') {
        startHostSession(activeRoomCode, activeBrokerIndex);
      } else {
        joinOnlineRoom(activeRoomCode, activeBrokerIndex, myClientId);
      }
    });

    leaveRoomBtn.addEventListener('click', () => {
      leaveOnlineRoom({ switchToLocal: false });
    });

    cellElements.forEach((cell, index) => {
      cell.addEventListener('click', () => handleCellClick(index));
      cell.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleCellClick(index);
        }
      });
    });

    localRestartBtn.addEventListener('click', () => {
      if (currentMode !== 'local') return;
      restartLocalGame();
    });

    localResetScoreBtn.addEventListener('click', () => {
      if (currentMode !== 'local') return;
      localState = Core.createLocalGameState();
      overlayDismissedForRound = null;
      hideWinningOverlay();
      render();
      showToast('Placar zerado!');
    });

    inlineRematchBtn.addEventListener('click', requestOnlineRematch);

    restartButton.addEventListener('click', () => {
      if (currentMode === 'local') {
        restartLocalGame();
      } else {
        requestOnlineRematch();
      }
    });

    closeOverlayBtn.addEventListener('click', () => {
      overlayDismissedForRound = getCurrentRoundKey();
      hideWinningOverlay();
    });
  }

  function parseRoomInput(value) {
    const trimmed = (value || '').trim();
    if (trimmed.includes('sala=')) {
      try {
        const url = trimmed.startsWith('http')
          ? new URL(trimmed)
          : new URL(trimmed, window.location.origin);
        return Core.parseInviteParams(url.search);
      } catch (_) {}
    }
    return {
      roomCode: Core.normalizeRoomCode(trimmed),
      brokerIndex: 0
    };
  }

  function setMode(mode, { clearUrl = true } = {}) {
    currentMode = mode;
    const isOnline = mode === 'online';

    modeLocalBtn.classList.toggle('active', !isOnline);
    modeLocalBtn.setAttribute('aria-pressed', String(!isOnline));
    modeOnlineBtn.classList.toggle('active', isOnline);
    modeOnlineBtn.setAttribute('aria-pressed', String(isOnline));

    onlinePanel.hidden = !isOnline;

    if (isOnline) {
      const inRoom = Boolean(activeRoomCode);
      onlineLobby.hidden = inRoom;
      onlineRoom.hidden = !inRoom;
      gameArea.hidden = !inRoom;
    } else {
      onlineLobby.hidden = true;
      onlineRoom.hidden = true;
      gameArea.hidden = false;
      if (clearUrl) clearRoomUrl();
    }

    hideWinningOverlay();
    render();
  }

  function clearRoomUrl() {
    const url = new URL(window.location.href);
    if (url.searchParams.has('sala') || url.searchParams.has('b')) {
      url.searchParams.delete('sala');
      url.searchParams.delete('b');
      window.history.replaceState({}, '', url.toString());
    }
  }

  function updateRoomUrl(roomCode, brokerIndex) {
    const inviteUrl = Core.buildInviteUrl(window.location.href, roomCode, brokerIndex);
    window.history.replaceState({}, '', inviteUrl);
    inviteLinkInput.value = inviteUrl;
  }

  function saveRoomSession() {
    if (!activeRoomCode || !myClientId || !onlineRole) return;
    try {
      sessionStorage.setItem(ROOM_SESSION_KEY, JSON.stringify({
        roomCode: activeRoomCode,
        clientId: myClientId,
        role: onlineRole,
        brokerIndex: activeBrokerIndex,
        roomState: onlineRole === 'host' ? onlineRoomState : null
      }));
    } catch (_) {}
  }

  function readRoomSession() {
    try {
      const raw = sessionStorage.getItem(ROOM_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function clearRoomSession() {
    try {
      sessionStorage.removeItem(ROOM_SESSION_KEY);
    } catch (_) {}
  }

  // ==================== LOCAL MODE ====================

  function restartLocalGame() {
    localState = Core.restartLocalRound(localState);
    overlayDismissedForRound = null;
    hideWinningOverlay();
    render();
  }

  // ==================== ONLINE MODE ====================

  function createOnlineRoom() {
    cleanupOnlineSession(false);

    onlineRole = 'host';
    myClientId = Core.generateClientId();
    activeRoomCode = Core.generateRoomCode(6);
    activeBrokerIndex = 0;
    hostDisconnected = false;
    pendingGuestMove = false;
    overlayDismissedForRound = null;

    onlineRoomState = Core.createHostRoomState({
      roomCode: activeRoomCode,
      hostId: myClientId,
      hostName: getPlayerName('Anfitrião')
    });

    setMode('online', { clearUrl: false });
    updateRoomUrl(activeRoomCode, activeBrokerIndex);
    saveRoomSession();
    startHostSession(activeRoomCode, activeBrokerIndex);
    render();
  }

  function resumeHostRoom(saved) {
    cleanupOnlineSession(false);
    onlineRole = 'host';
    myClientId = saved.clientId;
    activeRoomCode = saved.roomCode;
    activeBrokerIndex = saved.brokerIndex || 0;
    onlineRoomState = saved.roomState;
    hostDisconnected = false;
    pendingGuestMove = false;
    overlayDismissedForRound = null;

    setMode('online', { clearUrl: false });
    updateRoomUrl(activeRoomCode, activeBrokerIndex);
    startHostSession(activeRoomCode, activeBrokerIndex);
    render();
  }

  function startHostSession(roomCode, brokerIndex) {
    cleanupOnlineSession(false);
    retryConnectBtn.hidden = true;
    roomCodeBadge.textContent = `Sala: ${roomCode}`;
    inviteBox.hidden = false;

    onlineSession = new OnlineSession({
      roomCode,
      role: 'host',
      clientId: myClientId,
      playerName: onlineRoomState.hostName,
      brokerIndex,
      onStatus: (status, info) => {
        if (info && Number.isInteger(info.brokerIndex) && info.brokerIndex !== activeBrokerIndex) {
          activeBrokerIndex = info.brokerIndex;
          updateRoomUrl(activeRoomCode, activeBrokerIndex);
          saveRoomSession();
        }
        if (status === 'connecting') {
          setConnectionUI('connecting', 'Conectando sala...');
        } else if (status === 'connected') {
          if (onlineRoomState.guestId) {
            onlineSession.setTrackingPeer(true);
            onlineSession.send({ type: 'room_state', roomState: onlineRoomState });
            setConnectionUI('connected', 'Conectado — partida ativa');
          } else {
            setConnectionUI('waiting', 'Aguardando oponente entrar pelo link...');
          }
        } else if (status === 'reconnecting') {
          setConnectionUI('connecting', 'Reconectando...');
        }
      },
      onMessage: handleHostMessage,
      onPeerTimeout: () => {
        if (!onlineRoomState || !onlineRoomState.guestId) return;
        const left = Core.handleGuestLeave(onlineRoomState, onlineRoomState.guestId);
        if (left.left) {
          onlineRoomState = left.state;
          saveRoomSession();
          setConnectionUI('waiting', 'Oponente perdeu conexão. Aguardando...');
          showToast('Oponente perdeu a conexão.');
          hideWinningOverlay();
          render();
        }
      },
      onError: message => {
        setConnectionUI('error', message);
        retryConnectBtn.hidden = false;
      }
    });

    onlineSession.connect();
  }

  function handleHostMessage(msg) {
    if (!onlineRoomState || onlineRole !== 'host') return;

    if (msg.type === 'join_request') {
      const res = Core.handleJoinRequest(onlineRoomState, {
        clientId: msg.clientId,
        name: msg.name
      });

      if (!res.accepted) {
        if (res.reason === 'room_full') {
          onlineSession.send({
            type: 'room_full',
            targetId: msg.clientId
          });
        }
        return;
      }

      onlineRoomState = res.state;
      onlineSession.setTrackingPeer(true);
      saveRoomSession();
      onlineSession.send({ type: 'room_state', roomState: onlineRoomState });
      setConnectionUI('connected', 'Conectado — partida ativa');
      if (res.isNewGuest) {
        showToast(`${onlineRoomState.guestName} entrou na sala!`);
      }
      render();
      return;
    }

    if (msg.type === 'move') {
      if (msg.clientId !== onlineRoomState.guestId) return;
      const res = Core.handleOnlineMove(onlineRoomState, {
        clientId: msg.clientId,
        index: msg.index,
        round: msg.round
      });

      if (res.ok) {
        onlineRoomState = res.state;
        saveRoomSession();
      }
      onlineSession.send({ type: 'room_state', roomState: onlineRoomState });
      render();
      return;
    }

    if (msg.type === 'rematch_request') {
      if (msg.clientId !== onlineRoomState.guestId) return;
      const res = Core.handleRematchRequest(onlineRoomState, {
        clientId: msg.clientId,
        round: msg.round
      });
      if (res.ok) {
        onlineRoomState = res.state;
        if (res.startedNewRound) {
          overlayDismissedForRound = null;
          hideWinningOverlay();
        }
        saveRoomSession();
        onlineSession.send({ type: 'room_state', roomState: onlineRoomState });
        render();
      }
      return;
    }

    if (msg.type === 'leave') {
      const res = Core.handleGuestLeave(onlineRoomState, msg.clientId);
      if (res.left) {
        onlineSession.setTrackingPeer(false);
        onlineRoomState = res.state;
        saveRoomSession();
        setConnectionUI('waiting', 'Oponente saiu. Aguardando outro jogador...');
        showToast('Oponente saiu da sala.');
        hideWinningOverlay();
        render();
      }
    }
  }

  function joinOnlineRoom(roomCode, brokerIndex = 0, existingClientId = null) {
    cleanupOnlineSession(false);

    onlineRole = 'guest';
    myClientId = existingClientId || Core.generateClientId();
    activeRoomCode = roomCode;
    activeBrokerIndex = brokerIndex;
    onlineRoomState = null;
    hostDisconnected = false;
    pendingGuestMove = false;
    overlayDismissedForRound = null;

    setMode('online', { clearUrl: false });
    updateRoomUrl(activeRoomCode, activeBrokerIndex);
    saveRoomSession();

    retryConnectBtn.hidden = true;
    roomCodeBadge.textContent = `Sala: ${roomCode}`;
    inviteBox.hidden = false;

    onlineSession = new OnlineSession({
      roomCode,
      role: 'guest',
      clientId: myClientId,
      playerName: getPlayerName('Convidado'),
      brokerIndex,
      onStatus: status => {
        if (status === 'connecting') {
          setConnectionUI('connecting', `Entrando na sala ${roomCode}...`);
        } else if (status === 'connected') {
          setConnectionUI('connecting', 'Conectando ao anfitrião...');
          startJoinHandshake();
        } else if (status === 'reconnecting') {
          setConnectionUI('connecting', 'Reconectando...');
        }
      },
      onMessage: handleGuestMessage,
      onPeerTimeout: () => {
        if (hostDisconnected) return;
        hostDisconnected = true;
        setConnectionUI('error', 'Anfitrião perdeu conexão.');
        retryConnectBtn.hidden = false;
        showToast('O anfitrião perdeu a conexão.');
        render();
      },
      onError: message => {
        stopJoinHandshake();
        setConnectionUI('error', message);
        retryConnectBtn.hidden = false;
      }
    });

    onlineSession.connect();
    render();
  }

  function startJoinHandshake() {
    stopJoinHandshake();
    joinAttempts = 0;

    const sendJoin = () => {
      if (!onlineSession || onlineRole !== 'guest' || onlineRoomState) {
        stopJoinHandshake();
        return;
      }
      joinAttempts += 1;
      onlineSession.send({
        type: 'join_request',
        name: getPlayerName('Convidado')
      });

      if (joinAttempts === 7 && !onlineRoomState) {
        setConnectionUI('waiting', 'Aguardando anfitrião responder...');
        retryConnectBtn.hidden = false;
      }
    };

    sendJoin();
    joinRetryTimer = setInterval(sendJoin, 2000);
  }

  function stopJoinHandshake() {
    clearInterval(joinRetryTimer);
    joinRetryTimer = null;
  }

  function handleGuestMessage(msg) {
    if (onlineRole !== 'guest') return;

    if (msg.type === 'room_full' && msg.targetId === myClientId) {
      stopJoinHandshake();
      onlineSession.setTrackingPeer(false);
      setConnectionUI('error', 'Esta sala já está cheia (2 jogadores).');
      showToast('Sala cheia! Crie uma nova sala para jogar.');
      return;
    }

    if (msg.type === 'room_state' && msg.roomState) {
      const incoming = msg.roomState;
      if (incoming.guestId && incoming.guestId !== myClientId) return;

      const wasWaiting = !onlineRoomState;
      const roundChanged = onlineRoomState && incoming.round !== onlineRoomState.round;

      stopJoinHandshake();
      retryConnectBtn.hidden = true;
      hostDisconnected = false;
      pendingGuestMove = false;
      onlineRoomState = incoming;
      onlineSession.setTrackingPeer(true);

      if (roundChanged) {
        overlayDismissedForRound = null;
        hideWinningOverlay();
      }

      setConnectionUI('connected', 'Conectado — partida ativa');
      if (wasWaiting) {
        showToast(`Conectado com ${incoming.hostName}!`);
      }
      render();
      return;
    }

    if (msg.type === 'leave' && msg.role === 'host') {
      stopJoinHandshake();
      onlineSession.setTrackingPeer(false);
      hostDisconnected = true;
      setConnectionUI('error', 'O anfitrião encerrou a sala.');
      showToast('O anfitrião saiu da sala.');
      hideWinningOverlay();
      render();
    }
  }

  function leaveOnlineRoom({ switchToLocal = false } = {}) {
    cleanupOnlineSession(true);
    clearRoomSession();
    clearRoomUrl();

    onlineRole = null;
    myClientId = null;
    activeRoomCode = null;
    activeBrokerIndex = 0;
    onlineRoomState = null;
    hostDisconnected = false;
    pendingGuestMove = false;
    overlayDismissedForRound = null;

    if (switchToLocal) {
      setMode('local', { clearUrl: true });
    } else {
      setMode('online', { clearUrl: true });
    }
  }

  function cleanupOnlineSession(sendLeave) {
    stopJoinHandshake();
    clearTimeout(overlayTimer);
    if (onlineSession) {
      onlineSession.disconnect(sendLeave);
      onlineSession = null;
    }
  }

  // ==================== SHARED GAME ACTIONS ====================

  function handleCellClick(index) {
    if (currentMode === 'local') {
      const res = Core.applyLocalMove(localState, index);
      if (!res.ok) return;
      localState = res.state;
      render();
      return;
    }

    if (!onlineRoomState || hostDisconnected || onlineRoomState.status !== 'playing') return;
    if (onlineRoomState.board[index] !== null) return;
    if (Core.getExpectedPlayerId(onlineRoomState) !== myClientId) return;

    if (onlineRole === 'host') {
      const res = Core.handleOnlineMove(onlineRoomState, {
        clientId: myClientId,
        index,
        round: onlineRoomState.round
      });
      if (!res.ok) return;
      onlineRoomState = res.state;
      saveRoomSession();
      if (onlineSession) {
        onlineSession.send({ type: 'room_state', roomState: onlineRoomState });
      }
      render();
    } else if (onlineRole === 'guest') {
      if (pendingGuestMove) return;
      pendingGuestMove = true;
      if (onlineSession) {
        onlineSession.send({
          type: 'move',
          index,
          round: onlineRoomState.round
        });
      }
      render();
    }
  }

  function requestOnlineRematch() {
    if (currentMode !== 'online' || !onlineRoomState || hostDisconnected) return;
    if (onlineRoomState.status !== 'finished') return;

    if (onlineRole === 'host') {
      const res = Core.handleRematchRequest(onlineRoomState, {
        clientId: myClientId,
        round: onlineRoomState.round
      });
      if (!res.ok) return;
      onlineRoomState = res.state;
      if (res.startedNewRound) {
        overlayDismissedForRound = null;
        hideWinningOverlay();
      }
      saveRoomSession();
      if (onlineSession) {
        onlineSession.send({ type: 'room_state', roomState: onlineRoomState });
      }
      render();
    } else if (onlineRole === 'guest') {
      if (onlineSession) {
        onlineSession.send({
          type: 'rematch_request',
          round: onlineRoomState.round
        });
      }
      // Optimistic local mark until room_state arrives back
      onlineRoomState = {
        ...onlineRoomState,
        rematchReady: {
          ...onlineRoomState.rematchReady,
          [myClientId]: true
        }
      };
      render();
    }
  }

  // ==================== RENDERING ====================

  function setConnectionUI(state, text) {
    connectionStatusText.textContent = text;
    connectionDot.classList.remove('connected', 'error');
    if (state === 'connected') {
      connectionDot.classList.add('connected');
    } else if (state === 'error') {
      connectionDot.classList.add('error');
    }
  }

  function getCurrentRoundKey() {
    if (currentMode === 'local') {
      return `local_${localState.scores.x}_${localState.scores.circle}_${localState.scores.draws}`;
    }
    return onlineRoomState ? `online_${onlineRoomState.round}` : 'online_none';
  }

  function render() {
    if (currentMode === 'local') {
      renderLocal();
    } else {
      renderOnline();
    }
  }

  function renderLocal() {
    labelPlayerX.textContent = 'Jogador X';
    labelPlayerO.textContent = 'Jogador O';
    scoreXEl.textContent = String(localState.scores.x);
    scoreDrawsEl.textContent = String(localState.scores.draws);
    scoreOEl.textContent = String(localState.scores.circle);

    localRestartBtn.hidden = false;
    localResetScoreBtn.hidden = false;
    inlineRematchBtn.hidden = true;

    const isPlaying = localState.status === 'playing';
    playerXCard.classList.toggle('active-turn', isPlaying && !localState.circleTurn);
    playerOCard.classList.toggle('active-turn', isPlaying && localState.circleTurn);

    renderBoardCells(localState.board, localState.winningLine, isPlaying, localState.circleTurn);

    if (isPlaying) {
      statusBanner.textContent = `Vez de ${localState.circleTurn ? 'O' : 'X'}`;
      hideWinningOverlay();
    } else {
      const title = localState.winner
        ? `${localState.winner === Core.X_MARK ? 'X' : 'O'} Venceu!`
        : 'Empate!';
      statusBanner.textContent = title;
      scheduleWinningOverlay(title, 'Clique abaixo para iniciar a próxima rodada.', 'Jogar novamente', false);
    }
  }

  function renderOnline() {
    localRestartBtn.hidden = true;
    localResetScoreBtn.hidden = true;

    if (!onlineRoomState) {
      labelPlayerX.textContent = 'Jogador X';
      labelPlayerO.textContent = 'Jogador O';
      scoreXEl.textContent = '0';
      scoreDrawsEl.textContent = '0';
      scoreOEl.textContent = '0';
      playerXCard.classList.remove('active-turn');
      playerOCard.classList.remove('active-turn');
      inlineRematchBtn.hidden = true;
      renderBoardCells(Array(9).fill(null), null, false, false);
      statusBanner.textContent = onlineRole === 'host'
        ? 'Compartilhe o link acima para começar'
        : 'Conectando à sala...';
      hideWinningOverlay();
      return;
    }

    const s = onlineRoomState;
    const amHost = myClientId === s.hostId;
    const myMark = amHost ? s.hostMark : s.guestMark;
    const hostLabel = amHost ? `${s.hostName} (Você)` : s.hostName;
    const guestLabel = !amHost && s.guestId ? `${s.guestName} (Você)` : s.guestName;

    labelPlayerX.textContent = hostLabel;
    labelPlayerO.textContent = guestLabel;
    scoreXEl.textContent = String(s.scores.x);
    scoreDrawsEl.textContent = String(s.scores.draws);
    scoreOEl.textContent = String(s.scores.circle);

    const isPlaying = s.status === 'playing' && !hostDisconnected;
    const expectedId = Core.getExpectedPlayerId(s);
    const isMyTurn = isPlaying && expectedId === myClientId && !pendingGuestMove;

    playerXCard.classList.toggle('active-turn', isPlaying && !s.circleTurn);
    playerOCard.classList.toggle('active-turn', isPlaying && s.circleTurn);

    renderBoardCells(s.board, s.winningLine, isMyTurn, s.circleTurn);

    if (hostDisconnected) {
      statusBanner.textContent = 'O anfitrião encerrou a sala.';
      inlineRematchBtn.hidden = true;
      hideWinningOverlay();
      return;
    }

    if (s.status === 'waiting') {
      statusBanner.textContent = 'Aguardando oponente entrar pelo link de convite...';
      inlineRematchBtn.hidden = true;
      hideWinningOverlay();
      return;
    }

    if (s.status === 'playing') {
      inlineRematchBtn.hidden = true;
      hideWinningOverlay();
      const markSymbol = myMark === Core.X_MARK ? 'X' : 'O';
      const turnSymbol = s.circleTurn ? 'O' : 'X';
      if (pendingGuestMove) {
        statusBanner.textContent = 'Enviando jogada...';
      } else if (isMyTurn) {
        statusBanner.textContent = `Sua vez (${markSymbol}) — escolha uma casa`;
      } else {
        const oppName = amHost ? s.guestName : s.hostName;
        statusBanner.textContent = `Vez de ${oppName} (${turnSymbol})...`;
      }
      return;
    }

    // Finished
    const iWon = s.winner && s.winner === myMark;
    const title = !s.winner
      ? 'Empate!'
      : iWon
        ? 'Você venceu!'
        : `${amHost ? s.guestName : s.hostName} venceu!`;

    const readyMap = s.rematchReady || {};
    const iAmReady = Boolean(readyMap[myClientId]);
    const oppId = amHost ? s.guestId : s.hostId;
    const oppReady = Boolean(oppId && readyMap[oppId]);

    let subtext = 'Quer jogar mais uma rodada?';
    let btnText = 'Pedir revanche';
    let btnDisabled = false;

    if (iAmReady && !oppReady) {
      subtext = 'Aguardando oponente aceitar a revanche (1/2)...';
      btnText = 'Aguardando oponente...';
      btnDisabled = true;
    } else if (!iAmReady && oppReady) {
      subtext = 'Oponente pediu revanche!';
      btnText = 'Aceitar revanche';
    }

    statusBanner.textContent = `${title} ${oppReady && !iAmReady ? '— Oponente quer revanche!' : ''}`;
    inlineRematchBtn.hidden = false;
    inlineRematchBtn.textContent = btnText;
    inlineRematchBtn.disabled = btnDisabled;

    scheduleWinningOverlay(title, subtext, btnText, btnDisabled);
  }

  function renderBoardCells(boardState, winningLine, canInteract, circleTurn) {
    boardEl.classList.remove(Core.X_MARK, Core.CIRCLE_MARK, 'locked');
    if (canInteract) {
      boardEl.classList.add(circleTurn ? Core.CIRCLE_MARK : Core.X_MARK);
    } else {
      boardEl.classList.add('locked');
    }

    const winSet = new Set(winningLine || []);

    cellElements.forEach((cell, idx) => {
      const value = boardState[idx];
      const hasX = cell.classList.contains(Core.X_MARK);
      const hasO = cell.classList.contains(Core.CIRCLE_MARK);

      if (value === Core.X_MARK) {
        if (hasO) cell.classList.remove(Core.CIRCLE_MARK);
        if (!hasX) cell.classList.add(Core.X_MARK);
        cell.setAttribute('aria-label', `Casa ${idx + 1}: X`);
      } else if (value === Core.CIRCLE_MARK) {
        if (hasX) cell.classList.remove(Core.X_MARK);
        if (!hasO) cell.classList.add(Core.CIRCLE_MARK);
        cell.setAttribute('aria-label', `Casa ${idx + 1}: O`);
      } else {
        if (hasX) cell.classList.remove(Core.X_MARK);
        if (hasO) cell.classList.remove(Core.CIRCLE_MARK);
        cell.setAttribute('aria-label', `Casa ${idx + 1}: vazia`);
      }

      cell.classList.toggle('win', winSet.has(idx));
    });
  }

  function scheduleWinningOverlay(title, subtext, buttonText, buttonDisabled) {
    const roundKey = getCurrentRoundKey();
    winningTextEl.textContent = title;
    winningSubtextEl.textContent = subtext;
    restartButton.textContent = buttonText;
    restartButton.disabled = Boolean(buttonDisabled);

    if (overlayDismissedForRound === roundKey) {
      return;
    }

    if (winningMessageEl.classList.contains('show')) {
      return;
    }

    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => {
      if (overlayDismissedForRound === getCurrentRoundKey()) return;
      winningMessageEl.classList.add('show');
    }, 280);
  }

  function hideWinningOverlay() {
    clearTimeout(overlayTimer);
    winningMessageEl.classList.remove('show');
  }

  async function copyInviteLink() {
    const link = inviteLinkInput.value;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      showToast('Link de convite copiado!');
    } catch (_) {
      inviteLinkInput.select();
      document.execCommand('copy');
      showToast('Link de convite copiado!');
    }
  }

  async function shareInviteLink() {
    const link = inviteLinkInput.value;
    if (!link || typeof navigator.share !== 'function') return;
    try {
      await navigator.share({
        title: 'Jogo da Velha — Convite',
        text: 'Vem jogar Jogo da Velha comigo! Clique no link para entrar direto na partida:',
        url: link
      });
    } catch (_) {
      // User cancelled share sheet
    }
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.classList.add('show');
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 2600);
  }
}());