/**
 * BALKANSKI REMI — Kompletan server + Bot AI
 * Pravila:
 *  - 2–4 igrača, 2×52 karte + 2 jokera = 106 karata
 *  - Svaki igrač dobiva 14 karata
 *  - Inicijalni izlaz: min 51 bod u JEDNOM meldu (jokeri se NE računaju)
 *  - Joker zamjena: ako imaš prirodnu kartu koja zamjenjuje jokera, možeš ga uzeti
 *  - Živa figura: ne možeš završiti igru bacanjem jokera
 *  - Pobijedi onaj tko ostane bez karata
 *  - Bodovanje: -bodovi karata u ruci, +10 pobjedniku; kumulativno kroz runde
 */

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { pingTimeout: 60000 });

app.use(express.static("public"));

// ════════════════════════════════════════════════════════════════
//  KONSTANTE
// ════════════════════════════════════════════════════════════════

const SUITS  = ["♠","♥","♦","♣"];
const ORDER  = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const VALUES = { A:11,2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:10,Q:10,K:10,JOKER:25 };
const MIN_OPEN = 51;

// ════════════════════════════════════════════════════════════════
//  ŠPIL
// ════════════════════════════════════════════════════════════════

let _cardId = 0;
function makeCard(name, suit) {
  return { id: ++_cardId, name, suit, value: VALUES[name] ?? VALUES[suit] ?? 0 };
}

function newDeck() {
  const d = [];
  for (let x = 0; x < 2; x++) {
    SUITS.forEach(s => ORDER.forEach(n => d.push(makeCard(n, s))));
    d.push(makeCard("JOKER","🃏"));
  }
  return shuffle(d);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ════════════════════════════════════════════════════════════════
//  VALIDACIJA MELDOVA
// ════════════════════════════════════════════════════════════════

function isJoker(c) { return c.name === "JOKER"; }

function isSet(cards) {
  if (cards.length < 3 || cards.length > 4) return false;
  const real = cards.filter(c => !isJoker(c));
  if (real.length === 0) return false;
  const name  = real[0].name;
  const suits = new Set();
  for (const c of real) {
    if (c.name !== name) return false;
    if (suits.has(c.suit)) return false;
    suits.add(c.suit);
  }
  return true;
}

function isRun(cards) {
  if (cards.length < 3) return false;
  const real = cards.filter(c => !isJoker(c));
  if (real.length === 0) return false;
  const suit = real[0].suit;
  if (real.some(c => c.suit !== suit)) return false;

  const jokers  = cards.length - real.length;
  const hasAce  = real.some(c => c.name === "A");

  // Provjeri niz uz dani redosljed asa (nizak=0 ili visok=13)
  function tryOrder(aceHigh) {
    const idx    = n => (n === "A" && aceHigh) ? 13 : ORDER.indexOf(n);
    const sorted = [...real].sort((a, b) => idx(a.name) - idx(b.name));
    for (let i = 1; i < sorted.length; i++)
      if (sorted[i].name === sorted[i - 1].name) return false;
    let gaps = 0;
    for (let i = 1; i < sorted.length; i++)
      gaps += idx(sorted[i].name) - idx(sorted[i - 1].name) - 1;
    return gaps >= 0 && gaps <= jokers;
  }

  // As nizak (A,2,3…) ili As visok (…Q,K,A) — ali NE wrap-around (K,A,2)
  return tryOrder(false) || (hasAce && tryOrder(true));
}

function isValidMeld(cards)  { return isSet(cards) || isRun(cards); }

function canAppend(meld, card) { return isValidMeld([...meld, card]); }

function findSwappableJoker(meld, naturalCard) {
  for (let ji = 0; ji < meld.length; ji++) {
    if (!isJoker(meld[ji])) continue;
    const test = [...meld];
    test[ji] = naturalCard;
    if (isValidMeld(test)) return ji;
  }
  return -1;
}

// Bodovi bez jokera (za provjeru 51 pri otvaranju)
function naturalPoints(cards) {
  return cards.filter(c => !isJoker(c)).reduce((s,c) => s + c.value, 0);
}

// Ukupna vrijednost (za oduzimanje bodova)
function handValue(cards) {
  return cards.reduce((s,c) => s + c.value, 0);
}

// ════════════════════════════════════════════════════════════════
//  STANJE SOBE
// ════════════════════════════════════════════════════════════════

const rooms = {};

function makePlayer(socketId, name) {
  return {
    id: socketId, name,
    hand: [], opened: false,
    roundScore: 0, totalScore: 0,
    connected: true, isBot: false,
  };
}

function makeBotPlayer(name) {
  return {
    id:    `bot_${Math.random().toString(36).slice(2,7)}`,
    name,
    hand: [], opened: false,
    roundScore: 0, totalScore: 0,
    connected: true, isBot: true,
  };
}

function publicState(room) {
  return {
    id:         room.id,
    phase:      room.phase,
    turn:       room.turn,
    discardTop: room.discard.at(-1) ?? null,
    deckCount:  room.deck.length,
    table:      room.table,
    players:    room.players.map(p => ({
      id:         p.id,
      name:       p.name,
      count:      p.hand.length,
      opened:     p.opened,
      totalScore: p.totalScore,
      connected:  p.connected,
      isBot:      p.isBot,
    })),
  };
}

function nextTurn(room) {
  room.turn  = (room.turn + 1) % room.players.length;
  room.phase = "draw";
}

function broadcastState(room) {
  io.to(room.id).emit("state", publicState(room));
  scheduleBot(room); // ako je bot na redu, zakaži potez
}

function sendHand(room, player) {
  if (player.isBot) return; // boti nemaju socket
  io.to(player.id).emit("yourHand", player.hand);
}

// ════════════════════════════════════════════════════════════════
//  ZAVRŠETAK RUNDE
// ════════════════════════════════════════════════════════════════

const WINNER_BONUS    = -40;  // pobjednik dobiva −40
const UNOPENED_PENALTY = 100; // kazna za neotvaranje

function endRound(room, winner) {
  if (room.botTimeout) { clearTimeout(room.botTimeout); room.botTimeout = null; }

  room.players.forEach(p => {
    if (p.id === winner.id) {
      // Pobjednik: bonus −40 (smanjuje ukupni score)
      p.roundScore = WINNER_BONUS;
    } else {
      // Gubitnik: vrijednost karata u ruci
      p.roundScore = handValue(p.hand);
      // Nije se uspio otvoriti: dodatnih +100
      if (!p.opened) p.roundScore += UNOPENED_PENALTY;
    }
    p.totalScore += p.roundScore;
  });

  room.phase = "ended";

  io.to(room.id).emit("roundOver", {
    winnerName: winner.name,
    scores: room.players.map(p => ({
      name:        p.name,
      roundScore:  p.roundScore,
      totalScore:  p.totalScore,
      opened:      p.opened,
      isWinner:    p.id === winner.id,
    })),
  });
}

// ════════════════════════════════════════════════════════════════
//  BOT AI
// ════════════════════════════════════════════════════════════════

/**
 * Zakazuje bot potez s realističnim kašnjenjem (0.9–1.7s).
 * Poziva se automatski iz broadcastState.
 */
function scheduleBot(room) {
  const current = room.players[room.turn];
  if (!current?.isBot) return;
  if (!["draw","play"].includes(room.phase)) return;

  if (room.botTimeout) clearTimeout(room.botTimeout);
  room.botTimeout = setTimeout(() => {
    room.botTimeout = null;
    if (rooms[room.id]) makeBotMove(room);
  }, 900 + Math.random() * 800);
}

function makeBotMove(room) {
  const bot = room.players[room.turn];
  if (!bot?.isBot) return;
  if (room.phase === "draw") botDraw(room, bot);
  else if (room.phase === "play") botPlay(room, bot);
}

// ── BOT VUČENJE KARTE ─────────────────────────────────────────────
function botDraw(room, bot) {
  const discardTop = room.discard.at(-1);
  let tookDiscard = false;

  if (discardTop) {
    // Uzmi s otpada ako karta upotpunjuje kombinaciju u ruci
    const testHand = [...bot.hand, discardTop];
    const usefulInHand = botFindCombos(testHand)
      .some(combo => combo.some(c => c.id === discardTop.id));

    // Ili se može dodati na postojeći meld (ako je bot već otvoren)
    const fitsTable = bot.opened &&
      room.table.some(meld => canAppend(meld, discardTop));

    if (usefulInHand || fitsTable) {
      bot.hand.push(room.discard.pop());
      tookDiscard = true;
    }
  }

  if (!tookDiscard) {
    if (room.deck.length === 0) {
      const top = room.discard.pop();
      room.deck  = shuffle(room.discard);
      room.discard = top ? [top] : [];
    }
    if (room.deck.length === 0) {
      // Špil je potpuno prazan — preskoči potez
      nextTurn(room);
      broadcastState(room);
      room.players.forEach(p => sendHand(room, p));
      return;
    }
    bot.hand.push(room.deck.pop());
  }

  room.phase = "play";
  broadcastState(room); // ovo će zakazati bot "play" potez
  room.players.forEach(p => sendHand(room, p));
}

// ── BOT ODIGRAVANJE ───────────────────────────────────────────────
// PRAVILO: igrač UVIJEK mora završiti potez bacanjem karte.
// Bot nikad ne smije ostaviti ruku praznom — mora zadržati min. 1 kartu za bacanje.
function botPlay(room, bot) {

  // 1. OTVORI IGRU ako još nije (≥51 prirodnih bodova, ali zadržati min. 1 kartu)
  if (!bot.opened) {
    const combos  = botFindCombos(bot.hand);
    const opening = combos
      .filter(c => naturalPoints(c) >= MIN_OPEN && c.length < bot.hand.length)
      .sort((a,b) => naturalPoints(b) - naturalPoints(a))[0];

    if (opening) {
      const ids = new Set(opening.map(c => c.id));
      bot.hand  = bot.hand.filter(c => !ids.has(c.id));
      room.table.push(opening);
      bot.opened = true;
      // NE pozivamo endRound ovdje — bot mora još baciti kartu
    }
  }

  // 2. IGRAJ DODATNE MELDOVE — ali zadržati min. 1 kartu za bacanje
  if (bot.opened) {
    let played = true;
    while (played && bot.hand.length > 1) { // > 1, ne > 0
      played = false;
      const combos = botFindCombos(bot.hand);
      // Samo meldovi koji ne isprazne ruku
      const safe = combos.filter(c => c.length < bot.hand.length);
      if (safe.length > 0) {
        const best = safe[0];
        const ids  = new Set(best.map(c => c.id));
        bot.hand   = bot.hand.filter(c => !ids.has(c.id));
        room.table.push(best);
        played = true;
        // NE endRound — nastavljamo do bacanja
      }
    }

    // 3. DODAJ KARTE NA POSTOJEĆE MELDOVE (zadržati min. 1 kartu)
    let changed = true;
    while (changed && bot.hand.length > 1) { // > 1
      changed = false;
      outer:
      for (let mi = 0; mi < room.table.length; mi++) {
        const meld = room.table[mi];
        for (let ci = 0; ci < bot.hand.length; ci++) {
          const card = bot.hand[ci];
          if (isJoker(card)) continue;

          // Zamjena jokera — samo ako ostaje min. 1 karta nakon toga
          const jokerIdx = findSwappableJoker(meld, card);
          if (jokerIdx !== -1) {
            const jokerCard = meld[jokerIdx];
            const handWithoutCard = bot.hand.filter(c => c.id !== card.id);
            const jokerUseful = botFindCombos([...handWithoutCard, jokerCard]).length > 0;
            // Nakon zamjene: uklanjamo naturalCard, dodajemo joker → veličina ostaje ista
            if (jokerUseful) {
              meld[jokerIdx] = card;
              bot.hand.splice(ci, 1);
              bot.hand.push(jokerCard);
              changed = true;
              break outer;
            }
          }

          // Direktno dodaj — samo ako ostaje min. 1 karta
          if (canAppend(meld, card) && bot.hand.length > 1) {
            meld.push(card);
            bot.hand.splice(ci, 1);
            changed = true;
            break outer;
          }
        }
      }
    }
  }

  // 4. BACI NAJLOŠIJU KARTU (jedini put kad može doći do endRound)
  botDiscard(room, bot);
}

// ── BOT BACANJE KARTE ─────────────────────────────────────────────
function botDiscard(room, bot) {
  if (bot.hand.length === 0) return;

  // Ocijeni svaku kartu — koliko je korisna za potencijalne meldove
  function cardUsefulness(card) {
    if (isJoker(card)) return 10000; // nikad ne bacaj jokera

    const others = bot.hand.filter(c => c.id !== card.id);
    let score    = 0;

    for (const other of others) {
      if (isJoker(other)) { score += 35; continue; }

      // Isti naziv, različita boja → potencijalni set
      if (card.name === other.name && card.suit !== other.suit) score += 30;

      // Ista boja, blizak rang → potencijalni niz
      if (card.suit === other.suit && !isJoker(other)) {
        const diff = Math.abs(ORDER.indexOf(card.name) - ORDER.indexOf(other.name));
        if (diff === 1) score += 25;
        else if (diff === 2) score += 12;
      }
    }

    // Može li se karta dodati na meld (samo ako je bot otvoren)
    if (bot.opened) {
      for (const meld of room.table) {
        if (canAppend(meld, card)) score += 50;
      }
    }

    return score;
  }

  // Sortiraj: najmanji usefulness → baci; pri jednakosti baci veću vrijednost
  const sorted = [...bot.hand].sort((a, b) => {
    const diff = cardUsefulness(a) - cardUsefulness(b);
    if (diff !== 0) return diff;
    return b.value - a.value; // veći gubitak ako izgubimo = baci ga
  });

  let toDiscard = sorted[0];

  // Živa figura: ne smiješ baciti jokera kao zadnju kartu
  if (isJoker(toDiscard) && bot.hand.length === 1) {
    // Ovo ne bi trebalo se dogoditi u normalnoj igri,
    // ali ako se dogodi — preskoči potez da ne blokira igru
    nextTurn(room);
    broadcastState(room);
    room.players.forEach(p => sendHand(room, p));
    return;
  }

  removeFromHand(bot, [toDiscard.id]);
  room.discard.push(toDiscard);

  if (bot.hand.length === 0) { endRound(room, bot); return; }

  nextTurn(room);
  broadcastState(room);
  room.players.forEach(p => sendHand(room, p));
}

// ── BOT KOMBINATORIKA ─────────────────────────────────────────────

/**
 * Pronalazi sve validne meldove (3–N karata) u ruci.
 * Uklanja podskupove — preferira dulje kombinacije.
 * Sortira od najvrjednijeg.
 */
function botFindCombos(hand) {
  const all = [];
  for (let size = 3; size <= hand.length; size++) {
    for (const combo of cardCombinations(hand, size)) {
      if (isValidMeld(combo)) all.push(combo);
    }
  }
  // Sortiraj po vrijednosti DESC
  all.sort((a,b) => handValue(b) - handValue(a));
  // Makni podskupove (ako je [A,K,Q,J] valjan, ne treba [A,K,Q])
  return all.filter((combo, i) =>
    !all.some((other, j) =>
      j !== i &&
      other.length > combo.length &&
      combo.every(c => other.some(o => o.id === c.id))
    )
  );
}

/** Sve kombinacije veličine `size` iz niza `arr`. */
function cardCombinations(arr, size) {
  if (size === 0) return [[]];
  if (arr.length < size) return [];
  const [first, ...rest] = arr;
  return [
    ...cardCombinations(rest, size - 1).map(c => [first, ...c]),
    ...cardCombinations(rest, size),
  ];
}

// ════════════════════════════════════════════════════════════════
//  SOCKET LOGIKA
// ════════════════════════════════════════════════════════════════

io.on("connection", socket => {

  // ── KREIRANJE SOBE ───────────────────────────────────────────
  socket.on("createRoom", name => {
    name = (name || "").trim().slice(0, 20);
    if (!name) { socket.emit("err","Unesite ime."); return; }

    const id = Math.random().toString(36).substring(2,7).toUpperCase();
    rooms[id] = {
      id, host: socket.id,
      players:    [ makePlayer(socket.id, name) ],
      deck: [], discard: [], table: [],
      turn: 0, phase: "lobby",
      round: 0,
      botTimeout: null,
    };
    socket.join(id);
    socket.data.roomId = id;
    socket.emit("roomJoined", { roomId: id, isHost: true });
    io.to(id).emit("state", publicState(rooms[id]));
  });

  // ── PRIDRUŽIVANJE ────────────────────────────────────────────
  socket.on("joinRoom", ({ roomId, name }) => {
    name = (name || "").trim().slice(0, 20);
    const room = rooms[roomId];
    if (!room)                    { socket.emit("err","Soba ne postoji."); return; }
    if (!name)                    { socket.emit("err","Unesite ime."); return; }
    if (room.players.length >= 4) { socket.emit("err","Soba je puna (max 4)."); return; }
    if (room.phase !== "lobby")   { socket.emit("err","Igra je već u tijeku."); return; }

    room.players.push(makePlayer(socket.id, name));
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit("roomJoined", { roomId, isHost: false });
    io.to(roomId).emit("state", publicState(room));
    io.to(roomId).emit("chat", { system: true, text: `${name} se pridružio.` });
  });

  // ── DODAJ BOTA ───────────────────────────────────────────────
  socket.on("addBot", roomId => {
    const room = rooms[roomId];
    if (!room)                        { socket.emit("err","Soba ne postoji."); return; }
    if (socket.id !== room.host)      { socket.emit("err","Samo host može dodati bota."); return; }
    if (room.players.length >= 4)     { socket.emit("err","Soba je puna (max 4)."); return; }
    if (room.phase !== "lobby")       { socket.emit("err","Bota možeš dodati samo u lobbyu."); return; }

    const botNum  = room.players.filter(p => p.isBot).length + 1;
    const bot     = makeBotPlayer(`🤖 Bot ${botNum}`);
    room.players.push(bot);
    io.to(roomId).emit("state", publicState(room));
    io.to(roomId).emit("chat", { system: true, text: `${bot.name} dodan u igru.` });
  });

  // ── UKLONI BOTA ─────────────────────────────────────────────
  socket.on("removeBot", roomId => {
    const room = rooms[roomId];
    if (!room)                   return;
    if (socket.id !== room.host) return;
    if (room.phase !== "lobby")  return;
    const idx = room.players.findIndex(p => p.isBot);
    if (idx === -1) return;
    const name = room.players[idx].name;
    room.players.splice(idx, 1);
    io.to(roomId).emit("state", publicState(room));
    io.to(roomId).emit("chat", { system: true, text: `${name} uklonjen.` });
  });

  // ── START IGRE / NOVA RUNDA ──────────────────────────────────
  socket.on("startGame", roomId => {
    const room = rooms[roomId];
    if (!room)                    return;
    if (socket.id !== room.host)  return;
    if (room.players.length < 2)  { socket.emit("err","Trebaju minimalno 2 igrača."); return; }
    if (!["lobby","ended"].includes(room.phase)) return;

    if (room.botTimeout) { clearTimeout(room.botTimeout); room.botTimeout = null; }

    room.deck  = newDeck();
    room.table = [];
    room.discard = [];
    room.turn  = (room.round % room.players.length);
    room.phase = "draw";
    room.round++;

    room.players.forEach(p => {
      p.hand    = [];
      p.opened  = false;
      p.roundScore = 0;
    });

    for (let i = 0; i < 14; i++)
      room.players.forEach(p => p.hand.push(room.deck.pop()));

    room.discard.push(room.deck.pop());

    broadcastState(room); // zakazuje bot ako je bot prvi na redu
    room.players.forEach(p => sendHand(room, p));
    io.to(roomId).emit("gameStarted");
  });

  // ── VUCI S KUPA ─────────────────────────────────────────────
  socket.on("draw", roomId => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players[room.turn];
    if (p.id !== socket.id)    { socket.emit("err","Nije tvoj red."); return; }
    if (p.isBot)               return;
    if (room.phase !== "draw") { socket.emit("err","Već si vukao."); return; }

    if (room.deck.length === 0) {
      const top = room.discard.pop();
      room.deck  = shuffle(room.discard);
      room.discard = top ? [top] : [];
    }
    if (room.deck.length === 0) { socket.emit("err","Špil je prazan."); return; }

    p.hand.push(room.deck.pop());
    room.phase = "play";

    sendHand(room, p);
    broadcastState(room);
  });

  // ── VUCI S OTPADA ────────────────────────────────────────────
  socket.on("drawDiscard", roomId => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players[room.turn];
    if (p.id !== socket.id)    { socket.emit("err","Nije tvoj red."); return; }
    if (p.isBot)               return;
    if (room.phase !== "draw") { socket.emit("err","Već si vukao."); return; }
    if (!room.discard.length)  { socket.emit("err","Otpad je prazan."); return; }

    p.hand.push(room.discard.pop());
    room.phase = "play";

    sendHand(room, p);
    broadcastState(room);
  });

  // ── OTVORI IGRU (više meldova odjednom, ukupno ≥51 boda) ────────
  socket.on("meldOpen", (roomId, cardGroups) => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players[room.turn];
    if (p.id !== socket.id)    { socket.emit("err","Nije tvoj red."); return; }
    if (p.isBot)               return;
    if (room.phase !== "play") { socket.emit("err","Prvo vuci kartu."); return; }
    if (p.opened)              { socket.emit("err","Već si otvorio igru — koristi Položi."); return; }
    if (!Array.isArray(cardGroups) || cardGroups.length === 0)
      { socket.emit("err","Nema meldova za otvaranje."); return; }

    // Validiraj sve grupe
    const resolved = [];
    for (const ids of cardGroups) {
      if (!Array.isArray(ids) || ids.length < 3)
        { socket.emit("err","Svaki meld mora imati min. 3 karte."); return; }
      const cards = resolveCards(p.hand, ids);
      if (!cards) { socket.emit("err","Karta nije u tvojoj ruci."); return; }
      if (!isValidMeld(cards)) { socket.emit("err","Nevalidna kombinacija!"); return; }
      resolved.push({ ids, cards });
    }

    // Provjeri ukupne prirodne bodove
    const totalNat = resolved.reduce((sum, g) => sum + naturalPoints(g.cards), 0);
    if (totalNat < MIN_OPEN) {
      socket.emit("err", `Trebaš ${MIN_OPEN}+ bodova za otvaranje! (Imaš ${totalNat})`);
      return;
    }

    // Provjeri da ostaje min. 1 karta za bacanje
    const usedIds = new Set(resolved.flatMap(g => g.ids));
    if (p.hand.filter(c => !usedIds.has(c.id)).length === 0) {
      socket.emit("err", "Moraš zadržati barem 1 kartu za bacanje na otpad!");
      return;
    }

    // Sve OK — polozi meldove
    p.opened = true;
    for (const { ids, cards } of resolved) {
      removeFromHand(p, ids);
      room.table.push(cards);
    }

    // NE endRound — igrač mora još baciti kartu
    sendHand(room, p);
    broadcastState(room);
  });

  // ── POLOŽI NOVI MELD (samo za već otvorene igrače) ───────────
  socket.on("meld", (roomId, cardIds) => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players[room.turn];
    if (p.id !== socket.id)     { socket.emit("err","Nije tvoj red."); return; }
    if (p.isBot)                return;
    if (room.phase !== "play")  { socket.emit("err","Prvo vuci kartu."); return; }
    if (!p.opened)              { socket.emit("err","Za otvaranje koristi gumb 'Otvori igru!'."); return; }
    if (!cardIds || cardIds.length < 3) { socket.emit("err","Min. 3 karte."); return; }

    const cards = resolveCards(p.hand, cardIds);
    if (!cards) { socket.emit("err","Karta nije u tvojoj ruci."); return; }

    if (!isValidMeld(cards)) { socket.emit("err","Nevalidna kombinacija!"); return; }

    // Mora ostati min. 1 karta za bacanje
    if (p.hand.length - cardIds.length < 1) {
      socket.emit("err","Moraš zadržati barem 1 kartu za bacanje na otpad!");
      return;
    }

    removeFromHand(p, cardIds);
    room.table.push(cards);

    // NE endRound — igrač mora još baciti kartu
    sendHand(room, p);
    broadcastState(room);
  });

  // ── DODAJ NA TUĐI MELD ───────────────────────────────────────
  socket.on("addToMeld", (roomId, { meldIndex, cardId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players[room.turn];
    if (p.id !== socket.id)     { socket.emit("err","Nije tvoj red."); return; }
    if (p.isBot)                return;
    if (room.phase !== "play")  { socket.emit("err","Prvo vuci kartu."); return; }
    if (!p.opened)              { socket.emit("err","Moraš prvo otvoriti."); return; }

    const meld = room.table[meldIndex];
    if (!meld) { socket.emit("err","Taj meld ne postoji."); return; }

    const card = p.hand.find(c => c.id === cardId);
    if (!card) { socket.emit("err","Karta nije u tvojoj ruci."); return; }

    if (!canAppend(meld, card)) {
      socket.emit("err","Ta karta ne može ići u tu kombinaciju.");
      return;
    }

    // Mora ostati min. 1 karta za bacanje
    if (p.hand.length - 1 < 1) {
      socket.emit("err","Moraš zadržati barem 1 kartu za bacanje na otpad!");
      return;
    }

    removeFromHand(p, [cardId]);
    meld.push(card);

    // NE endRound — igrač mora još baciti kartu
    sendHand(room, p);
    broadcastState(room);
  });

  // ── ZAMJENA JOKERA ───────────────────────────────────────────
  socket.on("swapJoker", (roomId, { meldIndex, naturalCardId }) => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players[room.turn];
    if (p.id !== socket.id)    { socket.emit("err","Nije tvoj red."); return; }
    if (p.isBot)               return;
    if (room.phase !== "play") { socket.emit("err","Prvo vuci kartu."); return; }
    if (!p.opened)             { socket.emit("err","Moraš prvo otvoriti."); return; }

    const meld = room.table[meldIndex];
    if (!meld) { socket.emit("err","Taj meld ne postoji."); return; }

    const naturalCard = p.hand.find(c => c.id === naturalCardId);
    if (!naturalCard)          { socket.emit("err","Karta nije u tvojoj ruci."); return; }
    if (isJoker(naturalCard))  { socket.emit("err","Ne možeš zamijeniti joker jokerom."); return; }

    const jokerIdx = findSwappableJoker(meld, naturalCard);
    if (jokerIdx === -1) {
      socket.emit("err","Ta karta ne može zamijeniti jokera u toj kombinaciji.");
      return;
    }

    const joker     = meld[jokerIdx];
    meld[jokerIdx]  = naturalCard;
    removeFromHand(p, [naturalCardId]);
    p.hand.push(joker);

    sendHand(room, p);
    broadcastState(room);
  });

  // ── BACI KARTU ───────────────────────────────────────────────
  socket.on("discard", (roomId, cardId) => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players[room.turn];
    if (p.id !== socket.id)    { socket.emit("err","Nije tvoj red."); return; }
    if (p.isBot)               return;
    if (room.phase !== "play") { socket.emit("err","Prvo vuci kartu."); return; }

    const card = p.hand.find(c => c.id === cardId);
    if (!card) { socket.emit("err","Karta nije u tvojoj ruci."); return; }

    // Živa figura
    if (isJoker(card) && p.hand.length === 1) {
      socket.emit("err","Živa figura! Ne možeš završiti bacanjem jokera.");
      return;
    }

    removeFromHand(p, [cardId]);
    room.discard.push(card);

    if (p.hand.length === 0) { endRound(room, p); return; }

    nextTurn(room);
    broadcastState(room);
    room.players.forEach(pl => sendHand(room, pl));
  });

  // ── CHAT ─────────────────────────────────────────────────────
  socket.on("chat", ({ roomId, text }) => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p) return;
    text = (text || "").trim().slice(0, 200);
    if (!text) return;
    io.to(roomId).emit("chat", { name: p.name, text });
  });

  // ── DISCONNECT ───────────────────────────────────────────────
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const room   = rooms[roomId];
    if (!room) return;

    const p = room.players.find(pl => pl.id === socket.id);
    if (!p) return;

    p.connected = false;
    io.to(roomId).emit("chat", { system: true, text: `${p.name} se odspojio.` });

    if (room.players.every(pl => !pl.connected && !pl.isBot)) {
      setTimeout(() => {
        if (rooms[roomId] && room.players.every(pl => !pl.connected && !pl.isBot))
          delete rooms[roomId];
      }, 60000);
      return;
    }

    if (room.phase !== "lobby" && room.phase !== "ended") {
      if (room.players[room.turn]?.id === socket.id) {
        nextTurn(room);
        broadcastState(room);
      }
    }

    if (room.host === socket.id) {
      const newHost = room.players.find(pl => pl.connected && !pl.isBot);
      if (newHost) {
        room.host = newHost.id;
        io.to(newHost.id).emit("youAreHost");
      }
    }

    broadcastState(room);
  });

  // ── RECONNECT ────────────────────────────────────────────────
  socket.on("reconnect", ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit("err","Soba više ne postoji."); return; }

    const p = room.players.find(pl => pl.name === name && !pl.connected && !pl.isBot);
    if (!p) { socket.emit("err","Nema mjesta za reconnect."); return; }

    p.id        = socket.id;
    p.connected = true;
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit("roomJoined", { roomId, isHost: room.host === p.id });
    socket.emit("state", publicState(room));
    sendHand(room, p);
    io.to(roomId).emit("chat", { system: true, text: `${p.name} se vratio.` });
    broadcastState(room);
  });

});

// ════════════════════════════════════════════════════════════════
//  POMOĆNE FUNKCIJE
// ════════════════════════════════════════════════════════════════

function resolveCards(hand, cardIds) {
  const result    = [];
  const remaining = [...hand];
  for (const id of cardIds) {
    const i = remaining.findIndex(c => c.id === id);
    if (i === -1) return null;
    result.push(remaining[i]);
    remaining.splice(i, 1);
  }
  return result;
}

function removeFromHand(player, cardIds) {
  const ids = new Set(cardIds);
  for (const id of ids) {
    const i = player.hand.findIndex(c => c.id === id);
    if (i !== -1) player.hand.splice(i, 1);
  }
}

// ════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎴 Remi 51 → http://localhost:${PORT}`));
