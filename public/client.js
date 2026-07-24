/**
 * BALKANSKI REMI — Kompletan klijent
 */

const socket = io();

// ════════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════════

let roomId        = null;
let myHand        = [];
let myHandOrder   = [];
let selected      = new Set();
let gameState     = null;
let isHost        = false;
let myName        = "";

// Drag & drop (desktop HTML5)
let dragCardId       = null;
let dragSource       = null;
let dragOverCardId   = null;
let dragInsertBefore = true;

// Touch drag
let touchDragActive  = false;
const TOUCH_THRESHOLD = 10; // px pomaka za start draga

// Otvaranje igre — višestruki meldovi
let openingMelds    = []; // [ [cardId, ...], [cardId, ...], ... ]


// Hint
let hintCombos = [];
let hintIdx    = -1;

// ════════════════════════════════════════════════════════════════
//  DOM REFERENCE
// ════════════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);

const screenLobby  = $("screen-lobby");
const screenGame   = $("screen-game");

const inputName    = $("input-name");
const inputRoom    = $("input-room");
const btnCreate    = $("btn-create");
const btnJoin      = $("btn-join");
const btnReconnect = $("btn-reconnect");
const lobbyError   = $("lobby-error");

const lblRoom      = $("lbl-room");
const lblTurn      = $("lbl-turn");
const btnStart     = $("btn-start");
const btnNewRound  = $("btn-new-round");
const btnLeave     = $("btn-leave");

const oppTop       = $("opp-top");
const oppLeft      = $("opp-left");
const oppRight     = $("opp-right");
const myInfoBar    = $("my-info-bar");
const meldsArea    = $("melds-area");
const deckPile     = $("deck-pile");
const discardPile  = $("discard-pile");
const deckCount    = $("deck-count");

const handArea     = $("hand-area");
const btnMeld          = $("btn-meld");
const btnDiscard       = $("btn-discard");
const btnOpenGame      = $("btn-open-game");
const btnCancelOpening = $("btn-cancel-opening");
const openingStage     = $("opening-stage");
const selInfo          = $("sel-info");

const chatLog      = $("chat-log");
const chatInput    = $("chat-input");
const btnChat      = $("btn-chat");

const overlay      = $("overlay");
const overlayTitle = $("overlay-title");
const overlayBody  = $("overlay-body");
const overlayBtn   = $("overlay-btn");

// ════════════════════════════════════════════════════════════════
//  DINAMIČKI GUMBI (Sort + Hint)
// ════════════════════════════════════════════════════════════════

// ── Bot dugme (topbar, samo za host u lobbyu) ─────────────────────
const btnAddBot = document.createElement("button");
btnAddBot.id          = "btn-add-bot";
btnAddBot.className   = "btn-gold btn-sm";
btnAddBot.textContent = "🤖 + Bot";
btnAddBot.style.display = "none";
btnAddBot.onclick = () => socket.emit("addBot", roomId);
document.querySelector(".topbar-right").insertBefore(
  btnAddBot,
  document.getElementById("btn-start")
);

// ── Bodovni prag (topbar, samo za host između rundi) ───────────────
const scoreLimitWrap = document.createElement("label");
scoreLimitWrap.id = "score-limit-wrap";
scoreLimitWrap.style.display = "none";
scoreLimitWrap.innerHTML = `<span class="score-limit-lbl">Prag:</span>
<input id="input-score-limit" type="number" min="100" max="10000" step="100" value="2500" class="score-limit-input">
<span class="score-limit-lbl">bod</span>`;
document.querySelector(".topbar-right").insertBefore(
  scoreLimitWrap,
  document.getElementById("btn-start")
);
const inputScoreLimit = document.getElementById("input-score-limit");
inputScoreLimit.onchange = () => socket.emit("setScoreLimit", roomId, inputScoreLimit.value);

// Sortiranje — ciklički prelazi između: kombos → boja+rang
let _sortMode = 0; // 0 = kombos, 1 = boja+rang

const btnSort = document.createElement("button");
btnSort.id          = "btn-sort";
btnSort.className   = "btn-action btn-gray";
btnSort.title       = "Složi karte — izmjenjuje između sortiranja po kombinacijama i boji/rangu";
btnSort.textContent = "⇅ Kombos";
btnSort.onclick     = () => {
  _sortMode = (_sortMode + 1) % 2;
  if (_sortMode === 0) {
    myHandOrder = sortHandByCombos(myHand).map(c => c.id);
    btnSort.textContent = "⇅ Kombos";
  } else {
    myHandOrder = sortHand(myHand).map(c => c.id);
    btnSort.textContent = "⇅ Boja";
  }
  renderHand();
};
document.querySelector(".action-left").appendChild(btnSort);

const btnHint = document.createElement("button");
btnHint.id        = "btn-hint";
btnHint.className = "btn-action btn-gray";
btnHint.title     = "Pronađi validne kombinacije u ruci";
btnHint.textContent = "💡 Hint";
btnHint.onclick   = () => {
  // Ciklično prolazi kroz pronađene prijedloge
  if (hintCombos.length === 0 || hintIdx >= hintCombos.length - 1) {
    hintCombos = findValidCombos(myHand);
    hintIdx    = 0;
  } else {
    hintIdx++;
  }
  if (hintCombos.length === 0) {
    showToast("Nema validnih kombinacija u ruci.", "warn");
    return;
  }
  selected = new Set(hintCombos[hintIdx].map(c => c.id));
  showToast(`💡 Prijedlog ${hintIdx + 1} / ${hintCombos.length}`, "info");
  renderHand();
  updateButtons();
};
document.querySelector(".action-left").appendChild(btnHint);

// ════════════════════════════════════════════════════════════════
//  REDOSLIJED KARATA U RUCI
// ════════════════════════════════════════════════════════════════

function updateHandOrder(newHand) {
  const newIds = new Set(newHand.map(c => c.id));
  myHandOrder  = myHandOrder.filter(id => newIds.has(id));
  const existing = new Set(myHandOrder);
  for (const c of newHand) {
    if (!existing.has(c.id)) myHandOrder.push(c.id);
  }
}

function getOrderedHand() {
  const byId = {};
  myHand.forEach(c => { byId[c.id] = c; });
  return myHandOrder.map(id => byId[id]).filter(Boolean);
}

function reorderHand(movedId, targetId, insertBefore) {
  const from = myHandOrder.indexOf(movedId);
  if (from === -1) return;
  myHandOrder.splice(from, 1);
  let to = myHandOrder.indexOf(targetId);
  if (to === -1) { myHandOrder.push(movedId); return; }
  if (!insertBefore) to += 1;
  myHandOrder.splice(to, 0, movedId);
}

// ════════════════════════════════════════════════════════════════
//  LOBBY
// ════════════════════════════════════════════════════════════════

btnCreate.onclick = () => {
  myName = inputName.value.trim();
  if (!myName) { showLobbyError("Unesite ime!"); return; }
  hideLobbyError();
  socket.emit("createRoom", myName);
};

btnJoin.onclick = () => {
  myName = inputName.value.trim();
  const rid = inputRoom.value.trim().toUpperCase();
  if (!myName) { showLobbyError("Unesite ime!"); return; }
  if (!rid)    { showLobbyError("Unesite kod sobe!"); return; }
  hideLobbyError();
  socket.emit("joinRoom", { roomId: rid, name: myName });
};

btnReconnect.onclick = () => {
  myName = inputName.value.trim();
  const rid = inputRoom.value.trim().toUpperCase();
  if (!myName || !rid) { showLobbyError("Unesite ime i kod sobe za reconnect."); return; }
  socket.emit("reconnect", { roomId: rid, name: myName });
};

inputRoom.addEventListener("input", () => {
  inputRoom.value = inputRoom.value.toUpperCase();
});
inputName.addEventListener("keydown", e => { if (e.key === "Enter") btnJoin.click(); });

function showLobbyError(msg) { lobbyError.textContent = msg; lobbyError.style.display = "block"; }
function hideLobbyError()    { lobbyError.style.display = "none"; }

// ════════════════════════════════════════════════════════════════
//  SOCKET EVENTI
// ════════════════════════════════════════════════════════════════

socket.on("roomJoined", data => {
  roomId  = data.roomId;
  isHost  = data.isHost;
  localStorage.setItem("remi_room", roomId);
  localStorage.setItem("remi_name", myName);
  switchScreen("game");
  lblRoom.textContent       = "🃏 SOBA: " + roomId;
  btnStart.style.display    = isHost ? "inline-flex" : "none";
  btnNewRound.style.display = "none";
  btnAddBot.style.display   = "none"; // state event će prikazati ako treba
});

socket.on("youAreHost", () => {
  isHost = true;
  btnStart.style.display    = "none";
  btnNewRound.style.display = "inline-flex";
});

socket.on("gameStarted", () => {
  btnStart.style.display    = "none";
  btnNewRound.style.display = "none";
  btnAddBot.style.display   = "none";
  overlay.style.display     = "none";
  selected.clear();
  openingMelds    = [];
  _wasMyturn      = false;
  hintCombos = []; hintIdx = -1;
  renderOpeningStage();
  addChat({ system: true, text: "🎴 Nova runda je počela!" });
});

socket.on("state", state => {
  gameState = state;
  renderAll();

  // Timer
  const cur = state.players[state.turn];
  const isMe = cur?.id === socket.id;
  if (state.turnDeadline && ["draw","play"].includes(state.phase) && !cur?.isBot) {
    startTimerUI(state.turnDeadline);
  } else {
    stopTimerUI();
  }

  // Bot dugme: samo host, samo lobby, max 3 igrača (4. slot slobodan)
  const canAddBot = isHost && state.phase === "lobby" && state.players.length < 4;
  btnAddBot.style.display = canAddBot ? "inline-flex" : "none";

  // Bodovni prag: host između rundi ili u lobbyu
  const canSetLimit = isHost && ["lobby","ended"].includes(state.phase);
  scoreLimitWrap.style.display = canSetLimit ? "inline-flex" : "none";
  if (state.scoreLimit && document.activeElement !== inputScoreLimit)
    inputScoreLimit.value = state.scoreLimit;
});

socket.on("yourHand", hand => {
  hintCombos = []; hintIdx = -1;   // reset hinta
  updateHandOrder(hand);
  myHand = hand;
  renderHand();
  updateButtons();
});

socket.on("roundOver", data => { stopTimerUI(); showRoundOver(data); });
socket.on("chat",  msg => addChat(msg));
socket.on("err",   msg => showToast(msg, "error"));

// ════════════════════════════════════════════════════════════════
//  KONTROLE IGRE
// ════════════════════════════════════════════════════════════════

btnStart.onclick    = () => socket.emit("startGame", roomId);
btnNewRound.onclick = () => {
  overlay.style.display = "none";
  socket.emit("startGame", roomId);
};
btnLeave.onclick = () => {
  if (!confirm("Napustiti sobu?")) return;
  socket.emit("leaveRoom", roomId);
  roomId    = null;
  gameState = null;
  localStorage.removeItem("remi_room");
  overlay.style.display = "none";
  switchScreen("lobby");
};

deckPile.onclick = () => {
  if (!isMyTurn() || getPhase() !== "draw") return;
  // Animacija: karta leti iz kupa prema ruci (licem dolje — ne znamo što je)
  flyCard(deckPile, handArea, '<div class="card-back-mini"></div>');
  socket.emit("draw", roomId);
};

discardPile.onclick = () => {
  if (!isMyTurn() || getPhase() !== "draw") return;
  // Animacija: otpadna karta leti prema ruci
  const top = gameState?.discardTop;
  if (top) {
    const html = `<div class="card ${top.suit === "♥" || top.suit === "♦" ? "red" : "black"}">${top.name}${top.suit}</div>`;
    flyCard(discardPile, handArea, html);
  }
  socket.emit("drawDiscard", roomId);
};

// Discard pile — drop target za desktop drag
discardPile.ondragover = e => {
  if (!isMyTurn() || getPhase() !== "play") return;
  if (dragSource !== "hand") return;
  e.preventDefault();
  discardPile.classList.add("drag-over");
};
discardPile.ondragleave = () => discardPile.classList.remove("drag-over");
discardPile.ondrop = e => {
  e.preventDefault();
  discardPile.classList.remove("drag-over");
  if (dragCardId == null || !isMyTurn() || getPhase() !== "play") return;
  socket.emit("discard", roomId, dragCardId);
  selected.clear();
  dragCardId = null;
  dragSource  = null;
  renderHand();
  updateButtons();
};

btnMeld.onclick = () => {
  if (selected.size < 3) return;
  const cards = myHand.filter(c => selected.has(c.id));

  if (!isOpened()) {
    // Staging mod: dodaj meld u otvaranje
    if (!isValidMeldClient(cards)) {
      showToast("Nevalidna kombinacija!", "error");
      return;
    }
    openingMelds.push([...selected]);
    selected.clear();
    hintCombos = []; hintIdx = -1;
    renderHand();
    updateButtons();
    renderOpeningStage();
  } else {
    // Već otvoren — normalan meld
    socket.emit("meld", roomId, [...selected]);
    selected.clear();
    hintCombos = []; hintIdx = -1;
    renderHand();
    updateButtons();
  }
};

btnOpenGame.onclick = () => {
  if (openingMelds.length === 0) return;
  socket.emit("meldOpen", roomId, openingMelds);
  openingMelds = [];
  selected.clear();
  hintCombos = []; hintIdx = -1;
  renderHand();
  updateButtons();
  renderOpeningStage();
};

btnCancelOpening.onclick = () => {
  openingMelds = [];
  selected.clear();
  renderHand();
  updateButtons();
  renderOpeningStage();
};

btnDiscard.onclick = () => {
  if (selected.size !== 1) return;
  const [id] = selected;
  // Animacija: karta leti iz ruke prema otpadu
  const card = myHand.find(c => c.id === id);
  const selEl = handArea.querySelector(".card-hand.selected");
  if (card && selEl) {
    const isRed = card.suit === "♥" || card.suit === "♦";
    const html  = `<div class="card ${isRed ? "red" : "black"}" style="font-size:13px;padding:4px">${card.name}${card.suit}</div>`;
    flyCard(selEl, discardPile, html);
  }
  socket.emit("discard", roomId, id);
  selected.clear();
  renderHand();
  updateButtons();
};

// Chat
btnChat.onclick = sendChat;
chatInput.addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });
function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !roomId) return;
  socket.emit("chat", { roomId, text });
  chatInput.value = "";
}

// ════════════════════════════════════════════════════════════════
//  TURN TIMER
// ════════════════════════════════════════════════════════════════
let _timerRAF = null;
let _timerEl  = null;

function startTimerUI(deadline) {
  if (_timerRAF) cancelAnimationFrame(_timerRAF);

  // Stvori element ako ne postoji
  if (!_timerEl) {
    _timerEl = document.createElement("div");
    _timerEl.id = "turn-timer";
    document.getElementById("topbar").appendChild(_timerEl);
  }

  function tick() {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const pct  = left / 60;
    _timerEl.textContent = left + "s";
    _timerEl.className   = "turn-timer"
      + (pct <= 0.17 ? " timer-danger" : pct <= 0.33 ? " timer-warn" : "");
    if (left > 0) _timerRAF = requestAnimationFrame(tick);
    else          _timerEl.textContent = "";
  }
  tick();
}

function stopTimerUI() {
  if (_timerRAF) { cancelAnimationFrame(_timerRAF); _timerRAF = null; }
  if (_timerEl)  { _timerEl.textContent = ""; _timerEl.className = "turn-timer"; }
}

// ════════════════════════════════════════════════════════════════
//  ANIMACIJA KARTE U LETU
// ════════════════════════════════════════════════════════════════

function flyCard(fromEl, toEl, cardContent, onDone) {
  const from = fromEl.getBoundingClientRect();
  const to   = toEl.getBoundingClientRect();

  const ghost = document.createElement("div");
  ghost.className = "card-fly";
  ghost.innerHTML = cardContent;
  ghost.style.cssText = `
    left: ${from.left + from.width/2 - 27}px;
    top:  ${from.top  + from.height/2 - 39}px;
  `;
  document.body.appendChild(ghost);

  // Force reflow pa pokreni animaciju
  void ghost.offsetWidth;
  ghost.style.transition = "left .35s cubic-bezier(.4,0,.2,1), top .35s cubic-bezier(.4,0,.2,1), transform .35s, opacity .35s";
  ghost.style.left    = (to.left + to.width/2  - 27) + "px";
  ghost.style.top     = (to.top  + to.height/2 - 39) + "px";
  ghost.style.transform = "scale(1.15)";
  ghost.style.opacity = "0.85";

  setTimeout(() => {
    ghost.style.transform = "scale(0.7)";
    ghost.style.opacity   = "0";
  }, 280);

  setTimeout(() => {
    ghost.remove();
    if (onDone) onDone();
  }, 400);
}

// ════════════════════════════════════════════════════════════════
//  RENDER
// ════════════════════════════════════════════════════════════════

function renderAll() {
  if (!gameState) return;
  renderTableSeats();
  renderTable();
  renderMelds();
  updateButtons();
}

// ── STOLNI RASPORED IGRAČA ────────────────────────────────────────
let _wasMyturn = false;

/** Vraca poziciju ('bottom','top','left','right') za igrača na indexu i. */
function seatFor(i) {
  const players = gameState.players;
  const n = players.length;
  const myIdx = players.findIndex(p => p.id === socket.id);
  if (myIdx === -1) return i === 0 ? 'top' : i === 1 ? 'bottom' : i === 2 ? 'left' : 'right';
  const rel = (i - myIdx + n) % n;
  if (rel === 0) return 'bottom';
  if (n === 2) return 'top';
  if (n === 3) return rel === 1 ? 'left' : 'right';
  return rel === 1 ? 'left' : rel === 2 ? 'top' : 'right';
}

function scoreCssClass(p, scoreLimit) {
  const r = p.totalScore / scoreLimit;
  return p.eliminated ? 'chip-eliminated'
       : r >= 0.9  ? 'chip-danger'
       : r >= 0.75 ? 'chip-warn'
       : p.totalScore > 0 ? 'chip-bad'
       : p.totalScore < 0 ? 'chip-good' : '';
}

function renderTableSeats() {
  const { players, turn, phase } = gameState;
  const scoreLimit = gameState.scoreLimit || 2500;
  const isMobile   = window.innerWidth <= 640;

  // Reset svih panela
  [oppTop, oppLeft, oppRight].forEach(el => {
    el.innerHTML = ''; el.style.display = 'none'; el.className = 'opp-panel';
  });

  // Pronađi sebe
  const myIdx = players.findIndex(p => p.id === socket.id);

  if (isMobile) {
    // ── MOBITEL: svi protivnici kao chipovi u #opp-top ─────────────
    oppTop.classList.add('opp-mobile-bar');
    let hasOpponents = false;

    players.forEach((p, i) => {
      const isActive = i === turn;
      const sc = scoreCssClass(p, scoreLimit);

      if (p.id === socket.id) {
        // Moj info bar
        myInfoBar.innerHTML = `
          <div class="my-info ${isActive ? 'my-turn' : ''}">
            <span class="my-name">${escHtml(p.name)}</span>
            <span class="chip-score ${sc}">${p.totalScore}<span class="chip-limit">/${scoreLimit}</span></span>
            ${p.opened ? '<span class="chip-open">✓</span>' : ''}
            ${p.count === 1 ? '<span class="chip-last-card">⚠ ZADNJA!</span>' : ''}
            ${isActive ? '<span class="my-turn-badge">● MOJ RED</span>' : ''}
          </div>`;
      } else {
        // Protivnik kao chip
        hasOpponents = true;
        const mini = Math.min(p.count, 5);
        const backs = Array.from({length: mini}, () => '<div class="opp-card-mini"></div>').join('');
        const chip = document.createElement('div');
        chip.className = 'opp-mobile-chip'
          + (isActive   ? ' opp-chip-active'    : '')
          + (p.eliminated ? ' opp-chip-eliminated' : '')
          + (!p.connected ? ' opp-chip-disconnected' : '');
        chip.innerHTML = `
          <div class="opp-mini-cards">${backs}</div>
          <div class="opp-chip-body">
            <span class="opp-chip-name">${escHtml(p.name)}</span>
            <span class="opp-chip-sub">
              ${p.count}🃏
              <span class="chip-score ${sc}">${p.totalScore}</span>
              ${p.opened     ? '<span class="opp-opened">✓</span>' : ''}
              ${p.eliminated ? '<span class="opp-elim">❌</span>' : ''}
            </span>
          </div>
          ${isActive ? '<span class="opp-turn-dot">●</span>' : ''}`;
        oppTop.appendChild(chip);
      }
    });

    if (hasOpponents) oppTop.style.display = 'flex';

  } else {
    // ── DESKTOP: raspored oko stola ────────────────────────────────
    oppTop.classList.add('opp-h');
    oppLeft.classList.add('opp-v');
    oppRight.classList.add('opp-v');

    players.forEach((p, i) => {
      const seat = seatFor(i);
      const isActive = i === turn;
      const sc = scoreCssClass(p, scoreLimit);

      if (seat === 'bottom') {
        myInfoBar.innerHTML = `
          <div class="my-info ${isActive ? 'my-turn' : ''}">
            <span class="my-name">${escHtml(p.name)}</span>
            <span class="chip-score ${sc}">${p.totalScore}<span class="chip-limit">/${scoreLimit}</span></span>
            ${p.opened ? '<span class="chip-open">✓ Otvoren</span>' : ''}
            ${p.count === 1 ? '<span class="chip-last-card">⚠ ZADNJA!</span>' : ''}
            ${isActive ? '<span class="my-turn-badge">● TVJ RED</span>' : ''}
          </div>`;
        return;
      }

      const el = seat === 'top' ? oppTop : seat === 'left' ? oppLeft : oppRight;
      el.style.display = 'flex';
      if (isActive)     el.classList.add('opp-active');
      if (p.eliminated) el.classList.add('opp-eliminated');
      if (!p.connected) el.classList.add('opp-disconnected');

      const shown = Math.min(p.count, 6);
      const backs = Array.from({length: shown}, () => '<div class="opp-card-back"></div>').join('');
      el.innerHTML = `
        <div class="opp-seat">
          <div class="opp-cards">${backs}</div>
          <div class="opp-info">
            <span class="opp-name ${isActive ? 'opp-name-active' : ''}">${escHtml(p.name)}</span>
            ${isActive ? '<span class="opp-turn-dot">●</span>' : ''}
            <span class="opp-count">${p.count}🃏</span>
            <span class="chip-score ${sc}">${p.totalScore}</span>
            ${p.opened    ? '<span class="opp-opened">✓</span>' : ''}
            ${p.eliminated ? '<span class="opp-elim">❌</span>'  : ''}
            ${p.count === 1 ? '<span class="chip-last-card" style="font-size:10px">⚠1!</span>' : ''}
          </div>
        </div>`;
    });
  }

  // Topbar turn label (uvijek)
  const cur = players[turn];
  const myTurn = myIdx !== -1 && myIdx === turn;
  if (cur) {
    lblTurn.textContent = myTurn ? "🟢 Tvoj red!" : `⏳ ${escHtml(cur.name)} igra...`;
    lblTurn.className   = myTurn ? "turn-mine" : "turn-other";
  }
  if (myTurn && !_wasMyturn && phase === "draw") showToast("🟢 Tvoj red!", "info");
  _wasMyturn = myTurn;
}

function renderPlayersBar() { renderTableSeats(); }

// ── STOL (kup + otpad) ───────────────────────────────────────────
function renderTable() {
  const { discardTop, deckCount: dc, phase } = gameState;
  deckCount.textContent = dc;

  const canDraw = isMyTurn() && phase === "draw";
  deckPile.classList.toggle("active-pile", canDraw);
  discardPile.classList.toggle("active-pile", canDraw && !!discardTop);
  discardPile.classList.toggle("empty-pile", !discardTop);

  if (discardTop) {
    discardPile.innerHTML = cardHTML(discardTop, false);
    discardPile.title = "Klikni ili odvuci za uzimanje s otpada";
  } else {
    discardPile.innerHTML = `<span class="pile-empty-label">Otpad</span>`;
    discardPile.title = "";
  }
}

// ── MELDOVI ──────────────────────────────────────────────────────
let _prevMeldCount = 0;
function renderMelds() {
  meldsArea.innerHTML = "";
  if (!gameState.table.length) {
    meldsArea.innerHTML = `<div class="melds-empty">Stol je prazan — budi prvi koji položi kombinaciju!</div>`;
    _prevMeldCount = 0;
    return;
  }

  const curCount = gameState.table.length;

  gameState.table.forEach((meld, meldIdx) => {
    const div = document.createElement("div");
    // Novi meld (koji nije bio prošli put) dobiva animacijsku klasu
    div.className = "meld" + (meldIdx >= _prevMeldCount ? " meld-new" : "");

    div.onclick = () => {
      // Tap na meld s 1 selektiranom kartom → addToMeld (korisno na mobitelu)
      if (isMyTurn() && getPhase() === "play" && isOpened() && selected.size === 1) {
        const [cardId] = selected;
        socket.emit("addToMeld", roomId, { meldIndex: meldIdx, cardId });
        selected.clear();
        renderHand();
        updateButtons();
      }
    };

    // Desktop drag drop
    div.ondragover = e => {
      if (dragSource !== "hand") return;
      e.preventDefault();
      div.classList.add("drag-over");
    };
    div.ondragleave = () => div.classList.remove("drag-over");
    div.ondrop = e => {
      e.preventDefault();
      div.classList.remove("drag-over");
      if (dragCardId == null || dragSource !== "hand") return;
      socket.emit("addToMeld", roomId, { meldIndex: meldIdx, cardId: dragCardId });
      dragCardId = null;
      dragSource  = null;
    };

    // Postavi broj karata kao CSS varijablu za širinu melda
    div.style.setProperty("--meld-cards", meld.length);

    meld.forEach((c, pos) => {
      const el = document.createElement("div");
      el.className = "card card-sm " + cardColorClass(c);
      el.innerHTML = cardHTML(c, false);
      // Pozicija u lepezi (ravno)
      el.style.setProperty("--card-pos", pos);
      div.appendChild(el);
    });

    meldsArea.appendChild(div);
  });

  _prevMeldCount = curCount;
}

// ── RUKA ─────────────────────────────────────────────────────────
function renderHand() {
  clearDragIndicators();
  handArea.innerHTML = "";

  const ordered    = getOrderedHand();
  const total      = ordered.length;
  const midIndex   = (total - 1) / 2;
  const halfSpread = Math.min(22, total * 1.8);
  const overlapPx  = total <= 3 ? 4
                   : total <= 6 ? 16
                   : total <= 9 ? 26
                   : 34;

  ordered.forEach((c, i) => {
    const el = document.createElement("div");
    el.className  = "card card-hand " + cardColorClass(c);
    el.dataset.id = c.id;
    if (selected.has(c.id)) el.classList.add("selected");
    if (c.id === dragCardId)  el.classList.add("dragging");
    // Karte u staging areni su "zauzete" — vizualno ih osjenčaj
    const stagedIds = new Set(openingMelds.flat());
    if (stagedIds.has(c.id)) el.classList.add("staged");
    el.innerHTML  = cardHTML(c, true);
    el.draggable  = true;

    // Fan kut i překlapanje
    const relPos = i - midIndex;
    const angle  = (total > 1 && midIndex > 0) ? (relPos / midIndex) * halfSpread : 0;
    el.style.setProperty("--fan-rotate", `${angle.toFixed(2)}deg`);
    el.style.setProperty("--card-z", String(i + 1));  // za CSS calc() u hover/selected
    el.style.marginLeft = i > 0 ? `-${overlapPx}px` : "0";
    el.style.zIndex     = i + 1;

    // Touch drag (mobitel + tablet)
    initTouchDrag(el, c);

    // ── Klik → selekt ──────────────────────────────────────────
    el.onclick = () => {
      if (touchDragActive) return; // ignoriraj klik kad je touch drag aktivan
      toggleSelect(c.id);
    };

    // ── Desktop drag start ──────────────────────────────────────
    el.ondragstart = e => {
      dragCardId = c.id;
      dragSource  = "hand";
      e.dataTransfer.effectAllowed = "move";
      requestAnimationFrame(() => el.classList.add("dragging"));
    };

    el.ondragend = () => {
      dragCardId       = null;
      dragSource        = null;
      dragOverCardId   = null;
      dragInsertBefore = true;
      clearDragIndicators();
      renderHand();
    };

    // ── Desktop: drag over karta u ruci → reorder indikator ────
    el.ondragover = e => {
      if (dragSource !== "hand") return;
      if (dragCardId === c.id)   return;
      e.preventDefault();
      e.stopPropagation();

      const rect   = el.getBoundingClientRect();
      const inLeft = e.clientX < rect.left + rect.width / 2;
      dragOverCardId   = c.id;
      dragInsertBefore = inLeft;

      clearDragIndicators();
      el.classList.add(inLeft ? "drag-insert-before" : "drag-insert-after");
    };

    el.ondragleave = e => {
      if (!el.contains(e.relatedTarget)) {
        el.classList.remove("drag-insert-before", "drag-insert-after");
      }
    };

    // ── Desktop: drop na kartu → reorder ───────────────────────
    el.ondrop = e => {
      e.preventDefault();
      e.stopPropagation();
      if (dragSource !== "hand" || dragCardId == null) return;
      if (dragCardId === c.id) return;
      reorderHand(dragCardId, c.id, dragInsertBefore);
      dragCardId       = null;
      dragSource        = null;
      dragOverCardId   = null;
      clearDragIndicators();
      renderHand();
    };

    handArea.appendChild(el);
  });

  // hand-area fallback (drop na prazan prostor → kraj liste)
  handArea.ondragover = e => {
    if (dragSource !== "hand" || dragOverCardId !== null) return;
    e.preventDefault();
  };
  handArea.ondrop = e => {
    if (dragSource !== "hand" || dragCardId == null || dragOverCardId !== null) return;
    e.preventDefault();
    myHandOrder = myHandOrder.filter(id => id !== dragCardId);
    myHandOrder.push(dragCardId);
    dragCardId  = null;
    dragSource   = null;
    clearDragIndicators();
    renderHand();
  };

  updateSelInfo();
}

function clearDragIndicators() {
  document.querySelectorAll(".drag-insert-before, .drag-insert-after")
    .forEach(el => el.classList.remove("drag-insert-before", "drag-insert-after"));
}

function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  hintCombos = []; hintIdx = -1; // reset hinta pri ručnom odabiru
  renderHand();
  updateButtons();
}

function updateSelInfo() {
  if (selected.size === 0) { selInfo.textContent = ""; return; }
  const cards = myHand.filter(c => selected.has(c.id));
  const pts   = cards.filter(c => c.name !== "JOKER").reduce((s,c) => s+c.value, 0);
  let info    = `${selected.size} karta (${pts} bod.)`;
  if (selected.size >= 3) info += isValidMeldClient(cards) ? " ✅" : " ❌";
  selInfo.textContent = info;
}

// ── STAGING AREA PRIKAZ ──────────────────────────────────────────
function renderOpeningStage() {
  if (openingMelds.length === 0) {
    openingStage.style.display   = "none";
    btnOpenGame.style.display    = "none";
    btnCancelOpening.style.display = "none";
    return;
  }

  openingStage.style.display = "flex";

  // Izračunaj prirodne bodove svih stagiranih meldova
  const byId = {};
  myHand.forEach(c => { byId[c.id] = c; });
  // Uzmi u obzir i karte koje su još u openingMelds (možda su uklonjene iz myHand)
  let totalNat = 0;
  const chips = [];

  openingMelds.forEach((ids, idx) => {
    const cards = ids.map(id => byId[id]).filter(Boolean);
    const nat   = cards.filter(c => c.name !== "JOKER").reduce((s,c) => s + c.value, 0);
    totalNat   += nat;

    const label = cards.map(c => `${c.name}${c.suit}`).join(" ");
    chips.push({ idx, label, nat });
  });

  const ok = totalNat >= 51;

  openingStage.innerHTML = chips.map(ch => `
    <span class="opening-meld-chip">
      ${ch.label}
      <span class="chip-remove" data-idx="${ch.idx}" title="Ukloni">✕</span>
    </span>
  `).join("") + `<span class="opening-stage-pts ${ok ? "ok" : "bad"}">${totalNat}/51 bod.</span>`;

  // Attach remove handlers
  openingStage.querySelectorAll(".chip-remove").forEach(el => {
    el.onclick = () => {
      const i = parseInt(el.dataset.idx);
      openingMelds.splice(i, 1);
      selected.clear();
      renderHand();
      updateButtons();
      renderOpeningStage();
    };
  });

  btnOpenGame.style.display      = ok ? "inline-flex" : "none";
  btnCancelOpening.style.display = "inline-flex";
}

// ── GUMBI ────────────────────────────────────────────────────────
function updateButtons() {
  const phase  = getPhase();
  const myTurn = isMyTurn();
  const opened = isOpened();
  const play   = myTurn && phase === "play";
  const staging = !opened && openingMelds.length > 0;

  // "Dodaj meld" kad nije otvoren, "Položi" kad je otvoren
  const mustOpen = gameState?.mustOpenThisTurn && !opened;

  btnMeld.textContent = opened ? "🃏 Položi" : "🃏 Dodaj meld";
  btnMeld.disabled    = !(play && selected.size >= 3);

  // Ne možeš baciti dok se nisi otvorio (uzeo si s otpada)
  btnDiscard.disabled = !(play && selected.size === 1) || staging || mustOpen;

  // Upozorenje u sel-info
  if (mustOpen && play) {
    selInfo.textContent = "⚠ Uzeo si s otpada — moraš se otvoriti ovaj red!";
  }

  // Otvori igru! / Poništi — kontrolira renderOpeningStage()
  if (!play || opened) {
    openingStage.style.display     = "none";
    btnOpenGame.style.display      = "none";
    btnCancelOpening.style.display = "none";
    if (!play) openingMelds = [];
  }

  const drawPhase = myTurn && phase === "draw";
  deckPile.classList.toggle("clickable", drawPhase);
  discardPile.classList.toggle("clickable", drawPhase && !!gameState?.discardTop);
}

// ════════════════════════════════════════════════════════════════
//  ROUND OVER OVERLAY
// ════════════════════════════════════════════════════════════════

function showRoundOver({ winnerName, scores, eliminated = [], scoreLimit = 2500 }) {
  overlayTitle.textContent = `🏆 ${escHtml(winnerName)} pobijedio rundu!`;

  const sorted = [...scores].sort((a, b) => a.totalScore - b.totalScore);

  function roundLabel(s) {
    if (s.isWinner) return `−40 🏆`;
    if (s.eliminated && s.roundScore === 0) return `—`;
    let label = `+${s.roundScore}`;
    const parts = [];
    if (!s.opened && !s.isWinner) {
      const cardPts = s.roundScore - 100;
      parts.push(`karte: +${cardPts}`);
      parts.push(`nije otvorio: +100`);
    }
    return parts.length ? `${label} <span class="score-detail">(${parts.join(", ")})</span>` : label;
  }

  const elimNotice = eliminated.length
    ? `<p class="elim-notice">❌ Eliminirani ovom rundom: <strong>${eliminated.map(escHtml).join(", ")}</strong> (prešli ${scoreLimit} bodova)</p>`
    : "";

  overlayBody.innerHTML = `
    <p class="score-note">Niži zbroj = bolji rezultat &nbsp;|&nbsp; Prag: <strong>${scoreLimit}</strong> bod.</p>
    ${elimNotice}
    <table class="score-table">
      <thead><tr><th>Igrač</th><th>Ova runda</th><th>Ukupno</th></tr></thead>
      <tbody>
        ${sorted.map(s => `
          <tr class="${s.isWinner ? "winner-row" : ""} ${s.eliminated ? "eliminated-row" : ""} ${!s.opened && !s.isWinner && !s.eliminated ? "unopened-row" : ""}">
            <td>${escHtml(s.name)}
              ${!s.opened && !s.isWinner && !s.eliminated ? ' <span class="badge-unopened">nije otvorio</span>' : ''}
              ${s.eliminated ? ' <span class="badge-elim">❌</span>' : ''}
            </td>
            <td class="${s.isWinner ? "neg" : "pos"}">${roundLabel(s)}</td>
            <td class="${s.totalScore <= 0 ? "neg" : s.totalScore >= scoreLimit * 0.9 ? "score-danger" : "pos"}">${s.totalScore}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  overlayBtn.textContent = isHost ? "▶ Nova runda" : "⏳ Čekanje hosta...";
  overlayBtn.disabled    = !isHost;
  overlayBtn.onclick     = () => {
    overlay.style.display = "none";
    socket.emit("startGame", roomId);
  };
  overlay.style.display = "flex";
  overlay.classList.remove("anim-in");
  void overlay.offsetWidth; // reflow da resetira animaciju
  overlay.classList.add("anim-in");
  if (isHost) btnNewRound.style.display = "inline-flex";
}

socket.on("gameOver", ({ winnerName, scores }) => {
  overlayTitle.textContent = `🎉 Kraj igre! Pobjednik: ${escHtml(winnerName)}`;
  overlayBody.innerHTML = `
    <p class="score-note">Konačni poredak</p>
    <table class="score-table">
      <thead><tr><th>#</th><th>Igrač</th><th>Ukupno</th><th>Status</th></tr></thead>
      <tbody>
        ${scores.map((s, i) => `
          <tr class="${i === 0 && !s.eliminated ? "winner-row" : ""} ${s.eliminated ? "eliminated-row" : ""}">
            <td>${i + 1}.</td>
            <td>${escHtml(s.name)}</td>
            <td class="${s.totalScore <= 0 ? "neg" : "pos"}">${s.totalScore}</td>
            <td>${s.eliminated ? "❌ Eliminiran" : i === 0 ? "🏆 Pobjednik" : "✅"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  overlayBtn.textContent = "🔄 Nova igra";
  overlayBtn.disabled    = false;
  overlayBtn.onclick     = () => {
    overlay.style.display = "none";
    if (isHost) socket.emit("restartGame", roomId);
    btnNewRound.style.display = "none";
    btnStart.style.display    = isHost ? "inline-flex" : "none";
  };
  overlay.style.display = "flex";
  overlay.classList.remove("anim-in");
  void overlay.offsetWidth; // reflow da resetira animaciju
  overlay.classList.add("anim-in");
  btnNewRound.style.display = "none";
});

// ════════════════════════════════════════════════════════════════
//  CHAT
// ════════════════════════════════════════════════════════════════

let _unreadChat = 0;

function openChat() {
  const panel = $("chat-panel");
  panel.classList.toggle("open");
  if (panel.classList.contains("open")) {
    // Reset badge pri otvaranju
    _unreadChat = 0;
    const badge = $("chat-badge");
    badge.style.display = "none";
    badge.textContent = "";
    chatLog.scrollTop = chatLog.scrollHeight;
  }
}

function addChat(msg) {
  const div = document.createElement("div");
  div.className = "chat-msg" + (msg.system ? " system" : "");
  div.innerHTML = msg.system
    ? `<em>${escHtml(msg.text)}</em>`
    : `<strong>${escHtml(msg.name)}:</strong> ${escHtml(msg.text)}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;

  // Badge — samo ako je chat zatvoren i nije systemska poruka
  const panel = $("chat-panel");
  if (!panel.classList.contains("open") && !msg.system) {
    _unreadChat++;
    const badge = $("chat-badge");
    badge.textContent = _unreadChat > 9 ? "9+" : _unreadChat;
    badge.style.display = "inline-flex";
  }
}

// ════════════════════════════════════════════════════════════════
//  TOAST
// ════════════════════════════════════════════════════════════════

let toastTimer;
function showToast(msg, type = "error") {
  const t = $("toast");
  t.textContent = msg;
  t.className   = "toast show " + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}

// ════════════════════════════════════════════════════════════════
//  KARTE — HTML i boje
// ════════════════════════════════════════════════════════════════

function cardHTML(c, showCorners) {
  if (c.name === "JOKER") return `<div class="card-center joker-emoji">🃏</div>`;
  const col = (c.suit === "♥" || c.suit === "♦") ? "red" : "black";
  if (!showCorners) return `<div class="card-center ${col}">${c.name}<br>${c.suit}</div>`;
  return `
    <div class="card-corner tl ${col}">${c.name}<br>${c.suit}</div>
    <div class="card-center ${col}">${c.name}<br>${c.suit}</div>
    <div class="card-corner br ${col}">${c.name}<br>${c.suit}</div>
  `;
}

function cardColorClass(c) {
  if (c.name === "JOKER") return "joker";
  return (c.suit === "♥" || c.suit === "♦") ? "red" : "black";
}

// ════════════════════════════════════════════════════════════════
//  SORTIRANJE RUKE
// ════════════════════════════════════════════════════════════════

const ORDER      = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const SUIT_ORDER = { "♠":0, "♥":1, "♦":2, "♣":3, "🃏":4 };

function sortHand(hand) {
  return [...hand].sort((a, b) => {
    if (a.name === "JOKER" && b.name !== "JOKER") return 1;
    if (b.name === "JOKER" && a.name !== "JOKER") return -1;
    const sd = (SUIT_ORDER[a.suit] ?? 9) - (SUIT_ORDER[b.suit] ?? 9);
    if (sd !== 0) return sd;
    return ORDER.indexOf(a.name) - ORDER.indexOf(b.name);
  });
}

/**
 * Sortira ruku po kombinacijama: validni meldovi su grupirani s lijeva,
 * ostatak iza. Unutar grupe sortira po boji+rangu.
 */
function sortHandByCombos(hand) {
  const combos  = findValidCombos(hand); // već postoji
  const usedIds = new Set();
  const groups  = [];

  // Greedily rasporedi karte u combo grupe (veći prioritet = veći/vrjedniji meld)
  for (const combo of combos) {
    if (combo.every(c => !usedIds.has(c.id))) {
      const sorted = [...combo].sort((a,b) => {
        const sd = (SUIT_ORDER[a.suit]??9) - (SUIT_ORDER[b.suit]??9);
        return sd !== 0 ? sd : ORDER.indexOf(a.name) - ORDER.indexOf(b.name);
      });
      groups.push(sorted);
      combo.forEach(c => usedIds.add(c.id));
    }
  }

  // Ostatak — sortiraj po boji+rangu
  const leftover = sortHand(hand.filter(c => !usedIds.has(c.id)));

  return [...groups.flat(), ...leftover];
}

// ════════════════════════════════════════════════════════════════
//  VALIDACIJA NA KLIJENTU (UI feedback)
// ════════════════════════════════════════════════════════════════

function isValidMeldClient(cards) {
  const jokers = cards.filter(c => c.name === "JOKER").length;
  const real   = cards.filter(c => c.name !== "JOKER");

  if (cards.length >= 3 && cards.length <= 4 && real.length > 0) {
    const name = real[0].name;
    const suits = new Set();
    let ok = true;
    for (const c of real) {
      if (c.name !== name || suits.has(c.suit)) { ok = false; break; }
      suits.add(c.suit);
    }
    if (ok) return true;
  }

  if (cards.length >= 3 && real.length > 0) {
    const suit = real[0].suit;
    if (real.every(c => c.suit === suit)) {
      const hasAce = real.some(c => c.name === "A");

      function tryRunOrder(aceHigh) {
        const idx    = n => (n === "A" && aceHigh) ? 13 : ORDER.indexOf(n);
        const sorted = [...real].sort((a, b) => idx(a.name) - idx(b.name));
        let gaps = 0;
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].name === sorted[i - 1].name) return false;
          gaps += idx(sorted[i].name) - idx(sorted[i - 1].name) - 1;
        }
        return gaps >= 0 && gaps <= jokers;
      }

      // As nizak (A,2,3…) ili As visok (…Q,K,A) — ali ne wrap-around
      if (tryRunOrder(false) || (hasAce && tryRunOrder(true))) return true;
    }
  }

  return false;
}

// ════════════════════════════════════════════════════════════════
//  HINT — pronalazak validnih kombinacija
// ════════════════════════════════════════════════════════════════

/** Vraća sve podskupove zadane veličine. */
function getCombinations(arr, size) {
  if (size === 0) return [[]];
  if (arr.length < size) return [];
  const [first, ...rest] = arr;
  const with_   = getCombinations(rest, size - 1).map(c => [first, ...c]);
  const without = getCombinations(rest, size);
  return [...with_, ...without];
}

/**
 * Pronalazi sve validne meldove (3–7 karata) u ruci.
 * Uklanja podskupove — preferira dulje kombinacije.
 */
function findValidCombos(hand) {
  const combos = [];
  // C(14,3)=364 … C(14,7)=3432 — ukupno ~10k provjera, brzo
  for (let size = 3; size <= Math.min(hand.length, 7); size++) {
    for (const combo of getCombinations(hand, size)) {
      if (isValidMeldClient(combo)) combos.push(combo);
    }
  }
  // Ukloni podskupove duljih validnih combova
  return combos.filter((combo, i) =>
    !combos.some((other, j) =>
      j !== i &&
      other.length > combo.length &&
      combo.every(c => other.some(o => o.id === c.id))
    )
  );
}

// ════════════════════════════════════════════════════════════════
//  TOUCH DRAG SUSTAV
// ════════════════════════════════════════════════════════════════

/**
 * Dodaje touch drag na jednu kartu u ruci.
 * Tap (bez pomaka) → onclick za selekt.
 * Pomak > TOUCH_THRESHOLD → drag mod s ghost kartom.
 */
function initTouchDrag(el, card) {
  let startX = 0, startY = 0;
  let dragActive = false;
  let ghost = null;

  el.addEventListener("touchstart", e => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    dragActive  = false;
    dragCardId  = card.id;
    dragSource  = "hand";
  }, { passive: true });

  el.addEventListener("touchmove", e => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];

    // Čekaj threshold
    if (!dragActive) {
      if (Math.hypot(t.clientX - startX, t.clientY - startY) < TOUCH_THRESHOLD) return;
      dragActive      = true;
      touchDragActive = true;
      el.classList.add("dragging");

      // Kreiraj ghost kartu koja prati prst
      const rect    = el.getBoundingClientRect();
      const fanRot  = el.style.getPropertyValue("--fan-rotate") || "0deg";
      ghost = el.cloneNode(true);
      // Makni inline stilove koji bi omeli pozicioniranje
      ghost.style.cssText   = "";
      ghost.style.position  = "fixed";
      ghost.style.pointerEvents = "none";
      ghost.style.zIndex    = "1000";
      ghost.style.width     = rect.width  + "px";
      ghost.style.height    = rect.height + "px";
      ghost.style.transition = "none";
      ghost.style.opacity   = "0.92";
      ghost.style.boxShadow = "0 16px 40px rgba(0,0,0,0.7)";
      ghost.style.borderRadius = "9px";
      ghost.style.transformOrigin = "center center";
      ghost.style.transform = `rotate(${fanRot}) scale(1.1)`;
      ghost.style.left = (t.clientX - rect.width  / 2) + "px";
      ghost.style.top  = (t.clientY - rect.height * 0.8) + "px";
      document.body.appendChild(ghost);
    }

    e.preventDefault(); // sprječava scroll dok vučeš

    // Pomakni ghost
    ghost.style.left = (t.clientX - parseFloat(ghost.style.width)  / 2) + "px";
    ghost.style.top  = (t.clientY - parseFloat(ghost.style.height) * 0.8) + "px";

    // Pronađi element ispod prsta (ghost ima pointer-events: none)
    const under = document.elementFromPoint(t.clientX, t.clientY);

    // Resetiraj sve highlight klase
    document.querySelectorAll(".meld.drag-over").forEach(m => m.classList.remove("drag-over"));
    discardPile.classList.remove("drag-over");
    clearDragIndicators();
    dragOverCardId = null;

    if (under) {
      const meldEl     = under.closest(".meld");
      const discardEl  = under.closest("#discard-pile");
      const handCardEl = under.closest(".card-hand");

      if (meldEl && meldEl.parentElement === meldsArea) {
        meldEl.classList.add("drag-over");
      } else if (discardEl && isMyTurn() && getPhase() === "play") {
        discardPile.classList.add("drag-over");
      } else if (handCardEl && handCardEl.dataset.id) {
        const tid = parseInt(handCardEl.dataset.id);
        if (tid !== card.id) {
          const cr = handCardEl.getBoundingClientRect();
          dragInsertBefore = t.clientX < cr.left + cr.width / 2;
          dragOverCardId   = tid;
          handCardEl.classList.add(dragInsertBefore ? "drag-insert-before" : "drag-insert-after");
        }
      }
    }
  }, { passive: false });

  el.addEventListener("touchend", e => {
    if (!dragActive) {
      // Nije bio drag — klik se sam okida
      dragCardId = null;
      dragSource  = null;
      return;
    }
    dragActive      = false;
    touchDragActive = false;

    // Čišćenje
    if (ghost) { ghost.remove(); ghost = null; }
    el.classList.remove("dragging");
    document.querySelectorAll(".meld.drag-over").forEach(m => m.classList.remove("drag-over"));
    discardPile.classList.remove("drag-over");
    clearDragIndicators();

    // Izvrši akciju
    const t     = e.changedTouches[0];
    const under = document.elementFromPoint(t.clientX, t.clientY);

    if (under) {
      const meldEl     = under.closest(".meld");
      const discardEl  = under.closest("#discard-pile");
      const handCardEl = under.closest(".card-hand");

      if (meldEl && meldEl.parentElement === meldsArea) {
        const meldIdx = [...meldsArea.children].indexOf(meldEl);
        if (meldIdx >= 0 && dragCardId != null) {
          socket.emit("addToMeld", roomId, { meldIndex: meldIdx, cardId: dragCardId });
        }
      } else if (discardEl && isMyTurn() && getPhase() === "play" && dragCardId != null) {
        socket.emit("discard", roomId, dragCardId);
        selected.clear();
        updateButtons();
      } else if (handCardEl && dragOverCardId !== null && dragCardId != null) {
        reorderHand(dragCardId, dragOverCardId, dragInsertBefore);
      }
    }

    dragCardId     = null;
    dragSource      = null;
    dragOverCardId = null;
    renderHand();
  });
}

// ════════════════════════════════════════════════════════════════
//  HELPER FUNKCIJE
// ════════════════════════════════════════════════════════════════

function switchScreen(name) {
  screenLobby.style.display = name === "lobby" ? "flex"  : "none";
  screenGame.style.display  = name === "game"  ? "flex"  : "none";
  // Resetiraj animacije lobby kartice pri povratku
  if (name === "lobby") {
    const card = screenLobby.querySelector(".lobby-card");
    if (card) { card.style.animation = "none"; void card.offsetWidth; card.style.animation = ""; }
  }
}

function isMyTurn() {
  if (!gameState) return false;
  return gameState.players[gameState.turn]?.id === socket.id;
}

function getPhase()  { return gameState?.phase ?? ""; }

function isOpened() {
  if (!gameState) return false;
  return gameState.players.find(p => p.id === socket.id)?.opened ?? false;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}

// ════════════════════════════════════════════════════════════════
//  AUTO RECONNECT
// ════════════════════════════════════════════════════════════════

window.addEventListener("load", () => {
  // Loading screen → lobby
  const loadingEl = document.getElementById("screen-loading");
  const lobbyEl   = document.getElementById("screen-lobby");

  setTimeout(() => {
    // Fade out loading screen
    loadingEl.style.transition = "opacity .5s ease";
    loadingEl.style.opacity = "0";
    setTimeout(() => {
      loadingEl.style.display = "none";
      lobbyEl.style.display = "flex";
    }, 500);
  }, 1500);

  // Auto-reconnect
  const savedRoom = localStorage.getItem("remi_room");
  const savedName = localStorage.getItem("remi_name");
  if (savedRoom && savedName) {
    inputRoom.value = savedRoom;
    inputName.value = savedName;
    btnReconnect.style.display = "block";
  }
});

// Re-render raspored kad se promijeni veličina/orijentacija ekrana
let _resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => { if (gameState) renderAll(); }, 150);
});
window.addEventListener("orientationchange", () => {
  setTimeout(() => { if (gameState) renderAll(); }, 300);
});
