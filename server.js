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

// ── BOT CHAT PORUKE ───────────────────────────────────────────────
const BOT_CHAT_LINES = [
  "Imam plan. Nadam se da i karte imaju isti plan.",
  "Ovo nije sreća, ovo je algoritam. (Uglavnom sreća.)",
  "Joker? Koji joker? Ja ne vidim nikakav joker. 😇",
  "Znam svaki vaš potez. Samo se pravim da ne znam.",
  "Moji živci su od čelika. Jer ih nemam.",
  "Mogu računati karte. Ali ne znam zašto mi to ne pomaže.",
  "Strateška pauza. (Nisam znao što baciti.)",
  "Mislim da sam upravo pobijedio. Ili izgubio. Jedno od toga.",
  "U drugoj igri sam bio nepobjediv. U ovoj se tek zagrijavam.",
  "Analiza situacije: loša. Šanse za pobjedu: prisutne.",
  "Čujem vas kako razmišljate. Prestanite.",
  "Ovo je remi, ne poker. Ali blefam svejedno.",
  "Svaka bačena karta je mudra odluka. Neke mudrije od drugih.",
  "Ne brini, i ja bih nešto bacio da imam što baciti.",
  "Moje karte su kao horoskop — ne razumijem ih ali vjerujem.",
  "Rekli su mi da botovi ne mogu pobijediti u remi. Drže okladu?",
  "Statistički gledano, netko mora izgubiti. Nadam se da nisam ja.",
  "Upravo sam izračunao 14 mogućih poteza. Svi su loši.",
  "Imate li vi nešto? Jer ja nemam ništa.",
  "Šansa da dobijem ovaj krug: 50%. Ili 12%. Nisam siguran.",
  "Joker je moj prijatelj. Nažalost, rijetko dolazi u posjete.",
  "Ne bih rekao da gubim. Rekao bih da gradim suspense.",
  "Imam strategiju. Tajna je.",
  "Tko je bacio tu kartu?! Briljantno. (Bio sam to ja.)",
  "Opustite se, igra je duga. Ja sam strpljiv — nemam izbora.",
];

// ── BOT CHAT TIMERI ───────────────────────────────────────────────
function startBotChat(room) {
  stopBotChat(room); // osiguraj da nema duplikata

  room.botChatInterval = setInterval(() => {
    if (!rooms[room.id] || !["draw","play"].includes(room.phase)) return;
    const bots = room.players.filter(p => p.isBot && !p.eliminated);
    if (bots.length === 0) return;
    const bot = bots[Math.floor(Math.random() * bots.length)];
    const line = BOT_CHAT_LINES[Math.floor(Math.random() * BOT_CHAT_LINES.length)];
    io.to(room.id).emit("chat", { name: bot.name, text: line, system: false });
  }, 3 * 60 * 1000 + Math.random() * 30000); // 3–3.5 minuta (malo varijacije)
}

function stopBotChat(room) {
  if (room.botChatInterval) {
    clearInterval(room.botChatInterval);
    room.botChatInterval = null;
  }
}

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

// Sortira meld za prikaz: skale po rangu (As-visok ako Q/K prisutni), setovi po boji
function sortMeld(meld) {
  const real   = meld.filter(c => !isJoker(c));
  const jokers = meld.filter(c =>  isJoker(c));
  if (real.length === 0) return [...meld];

  // SET (iste figure, različite boje) — sortiraj po boji
  const names = new Set(real.map(c => c.name));
  if (names.size === 1) {
    const SO = { "♠":0,"♥":1,"♦":2,"♣":3 };
    const sorted = [...real].sort((a,b) => (SO[a.suit]??9)-(SO[b.suit]??9));
    return [...sorted, ...jokers];
  }

  // SKALA — sortiraj po rangu, jokeri u praznine
  const hasAce      = real.some(c => c.name === "A");
  const hasHighCard  = real.some(c => c.name === "Q" || c.name === "K");
  const aceHigh      = hasAce && hasHighCard;
  const getIdx       = n => (n === "A" && aceHigh) ? 13 : ORDER.indexOf(n);

  const sortedReal = [...real].sort((a,b) => getIdx(a.name) - getIdx(b.name));
  if (jokers.length === 0) return sortedReal;

  // Ubaci jokere u praznine između karata
  const result = [];
  let pool = [...jokers];
  for (let i = 0; i < sortedReal.length; i++) {
    result.push(sortedReal[i]);
    if (i < sortedReal.length - 1 && pool.length > 0) {
      const gap = getIdx(sortedReal[i+1].name) - getIdx(sortedReal[i].name) - 1;
      for (let g = 0; g < gap && pool.length > 0; g++) result.push(pool.shift());
    }
  }
  result.push(...pool); // preostali jokeri na kraj
  return result;
}

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
    connected: true, isBot: false, eliminated: false,
  };
}

function makeBotPlayer(name) {
  return {
    id:    `bot_${Math.random().toString(36).slice(2,7)}`,
    name,
    hand: [], opened: false,
    roundScore: 0, totalScore: 0,
    connected: true, isBot: true, eliminated: false,
  };
}

function publicState(room) {
  return {
    id:                 room.id,
    phase:              room.phase,
    turn:               room.turn,
    discardTop:         room.discard.at(-1) ?? null,
    deckCount:          room.deck.length,
    table:              room.table.map(sortMeld),
    mustOpenThisTurn:   room.mustOpenThisTurn || false,
    scoreLimit:         room.scoreLimit,
    players:    room.players.map(p => ({
      id:         p.id,
      name:       p.name,
      count:      p.hand.length,
      opened:     p.opened,
      totalScore: p.totalScore,
      connected:  p.connected,
      isBot:      p.isBot,
      eliminated: p.eliminated || false,
    })),
  };
}

function nextTurn(room) {
  const n = room.players.length;
  let next = (room.turn + 1) % n;
  for (let i = 0; i < n; i++) {
    if (!room.players[next].eliminated) break;
    next = (next + 1) % n;
  }
  room.turn             = next;
  room.phase            = "draw";
  room.mustOpenThisTurn = false;
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
  stopBotChat(room);

  room.players.forEach(p => {
    if (p.eliminated) return;
    if (p.id === winner.id) {
      p.roundScore = WINNER_BONUS;
    } else {
      p.roundScore = handValue(p.hand);
      if (!p.opened) p.roundScore += UNOPENED_PENALTY;
    }
    p.totalScore += p.roundScore;
  });

  // Provjeri nova eliminiranja (totalScore >= prag)
  const newlyEliminated = [];
  room.players.forEach(p => {
    if (!p.eliminated && p.totalScore >= room.scoreLimit) {
      p.eliminated = true;
      newlyEliminated.push(p.name);
    }
  });

  room.phase = "ended";

  io.to(room.id).emit("roundOver", {
    winnerName:      winner.name,
    eliminated:      newlyEliminated,
    scoreLimit:      room.scoreLimit,
    scores: room.players.map(p => ({
      name:        p.name,
      roundScore:  p.roundScore,
      totalScore:  p.totalScore,
      opened:      p.opened,
      isWinner:    p.id === winner.id,
      eliminated:  p.eliminated || false,
    })),
  });

  // Kraj igre ako je ostao ≤1 aktivan igrač
  const active = room.players.filter(p => !p.eliminated);
  if (active.length <= 1) {
    const gameWinner = active[0]
      || [...room.players].sort((a,b) => a.totalScore - b.totalScore)[0];
    io.to(room.id).emit("gameOver", {
      winnerName: gameWinner.name,
      scores: [...room.players]
        .sort((a,b) => a.totalScore - b.totalScore)
        .map(p => ({
          name:       p.name,
          totalScore: p.totalScore,
          eliminated: p.eliminated || false,
        })),
    });
  }
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
    const testHand = [...bot.hand, discardTop];

    let shouldTake = false;

    if (bot.opened) {
      // Otvoren: uzmi ako karta odmah koristi (meld u ruci ili dodaj na stol)
      const usefulInHand = botFindCombos(testHand)
        .some(combo => combo.some(c => c.id === discardTop.id));
      const fitsTable = room.table.some(meld => canAppend(meld, discardTop));
      shouldTake = usefulInHand || fitsTable;
    } else {
      // Nije otvoren: uzmi SAMO ako može odmah otvoriti s tom kartom
      shouldTake = canPlayerOpenWith(testHand);
    }

    if (shouldTake) {
      bot.hand.push(room.discard.pop());
      tookDiscard = true;
      if (!bot.opened) room.mustOpenThisTurn = true;
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
function botPlay(room, bot) {

  // 1. OTVORI IGRU — koristi isti algoritam kao canPlayerOpenWith (garantirano konzistentno)
  if (!bot.opened) {
    const openingGroups = findOpeningMeldsFor(bot.hand);
    if (openingGroups) {
      for (const meld of openingGroups) {
        const ids = new Set(meld.map(c => c.id));
        bot.hand  = bot.hand.filter(c => !ids.has(c.id));
        room.table.push(meld);
      }
      bot.opened = true;
      room.mustOpenThisTurn = false;
    } else if (room.mustOpenThisTurn) {
      // Trebao se otvoriti (uzeo s otpada) ali ne može — preskoči red kao fallback
      room.mustOpenThisTurn = false;
      nextTurn(room);
      broadcastState(room);
      room.players.forEach(p => sendHand(room, p));
      return;
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

  // Sigurnosni guard: bot uzeo s otpada ali se nije otvorio — ne smije baciti
  if (room.mustOpenThisTurn && !bot.opened) {
    room.mustOpenThisTurn = false;
    nextTurn(room);
    broadcastState(room);
    room.players.forEach(p => sendHand(room, p));
    return;
  }

  // Ocijeni svaku kartu — što je veći score, to je karta korisnija (ne bacaj je)
  function cardUsefulness(card) {
    if (isJoker(card)) return 100000; // nikad ne bacaj jokera

    const others = bot.hand.filter(c => c.id !== card.id);
    let score    = 0;

    // ── Provjeri je li dio VALIDNOG MELDA s 2+ kartama u ruci ─────
    for (let i = 0; i < others.length; i++) {
      for (let j = i + 1; j < others.length; j++) {
        if (isValidMeld([card, others[i], others[j]])) {
          score += 200; // dio kompletne kombinacije — iznimno vrijedno
        }
      }
    }

    // ── Parcijalni par / niz (2 karte) ────────────────────────────
    for (const other of others) {
      if (isJoker(other)) { score += 50; continue; }

      if (card.name === other.name && card.suit !== other.suit) score += 40; // potencijalni set
      if (card.suit === other.suit) {
        const diff = Math.abs(ORDER.indexOf(card.name) - ORDER.indexOf(other.name));
        if (diff === 1) score += 35;      // susjedni u nizu
        else if (diff === 2) score += 18; // razmak od 1 (joker može popuniti)
      }
    }

    // ── Odgovara postojećem meldu na stolu ────────────────────────
    if (bot.opened) {
      for (const meld of room.table) {
        if (canAppend(meld, card)) score += 70;
      }
    }

    // ── Kazna za visoke karte bez combo potencijala (skupo zadržati) ─
    // U penalty sustavu, visoke karte bez kombinacije = visoka kazna pri kraju
    if (score < 30) score -= card.value * 0.5;

    return score;
  }

  // Sortiraj: najmanji usefulness → baci
  const sorted = [...bot.hand].sort((a, b) => {
    const diff = cardUsefulness(a) - cardUsefulness(b);
    if (diff !== 0) return diff;
    return b.value - a.value; // pri jednakom usefulness, baci skuplje
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
      scoreLimit:         2500,
      botTimeout:         null,
      mustOpenThisTurn:   false,
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
    if (!room)                   return;
    if (socket.id !== room.host) return;
    if (!["lobby","ended"].includes(room.phase)) return;

    const active = room.players.filter(p => !p.eliminated);
    if (active.length < 2) { socket.emit("err","Nedovoljno aktivnih igrača za novu rundu."); return; }

    if (room.botTimeout) { clearTimeout(room.botTimeout); room.botTimeout = null; }

    room.deck    = newDeck();
    room.table   = [];
    room.discard = [];

    // Red počinje na sljedećem aktivnom igraču u rotaciji
    const startPlayer = active[room.round % active.length];
    room.turn  = room.players.indexOf(startPlayer);
    room.phase = "draw";
    room.round++;

    room.players.forEach(p => {
      p.hand       = [];
      p.opened     = false;
      p.roundScore = 0;
    });

    // Dijeli karte samo aktivnim igračima
    for (let i = 0; i < 14; i++)
      active.forEach(p => p.hand.push(room.deck.pop()));

    room.discard.push(room.deck.pop());

    broadcastState(room);
    room.players.forEach(p => sendHand(room, p));
    io.to(roomId).emit("gameStarted");

    // Pokretanje bot chat timera ako ima botova
    if (room.players.some(p => p.isBot)) startBotChat(room);
  });

  // ── POSTAVI BODOVNI PRAG ─────────────────────────────────────
  socket.on("setScoreLimit", (roomId, limit) => {
    const room = rooms[roomId];
    if (!room)                   return;
    if (socket.id !== room.host) return;
    if (!["lobby","ended"].includes(room.phase)) {
      socket.emit("err","Prag se može mijenjati samo između rundi."); return;
    }
    const n = parseInt(limit);
    if (isNaN(n) || n < 100 || n > 10000) {
      socket.emit("err","Bodovni prag mora biti između 100 i 10000."); return;
    }
    room.scoreLimit = n;
    broadcastState(room);
  });

  // ── RESET IGRE (nova igra od početka) ────────────────────────
  socket.on("restartGame", roomId => {
    const room = rooms[roomId];
    if (!room)                   return;
    if (socket.id !== room.host) return;
    room.phase = "lobby";
    room.round = 0;
    room.table = []; room.deck = []; room.discard = [];
    room.players.forEach(p => {
      p.hand = []; p.opened = false;
      p.roundScore = 0; p.totalScore = 0; p.eliminated = false;
    });
    broadcastState(room);
    room.players.forEach(p => sendHand(room, p));
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
  // Pravilo: ako nisi otvoren, moraš se otvoriti ovaj red
  socket.on("drawDiscard", roomId => {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players[room.turn];
    if (p.id !== socket.id)    { socket.emit("err","Nije tvoj red."); return; }
    if (p.isBot)               return;
    if (room.phase !== "draw") { socket.emit("err","Već si vukao."); return; }
    if (!room.discard.length)  { socket.emit("err","Otpad je prazan."); return; }

    const card = room.discard.at(-1);

    // Ako još nije otvoren — provjeri može li se otvoriti s tom kartom
    if (!p.opened) {
      const testHand = [...p.hand, card];
      if (!canPlayerOpenWith(testHand)) {
        socket.emit("err", "Ne možeš uzeti s otpada — ne možeš se otvoriti s tom kartom!");
        return;
      }
      room.mustOpenThisTurn = true;
    }

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

    // Mora ostati min. 1 karta za bacanje
    if (p.hand.length - 1 < 1) {
      socket.emit("err","Moraš zadržati barem 1 kartu za bacanje na otpad!");
      return;
    }

    // Auto-zamjena jokera: ako karta može zauzeti jokerovo mjesto, joker ide u ruku
    const jokerIdx = !isJoker(card) ? findSwappableJoker(meld, card) : -1;
    if (jokerIdx !== -1) {
      const joker    = meld[jokerIdx];
      meld[jokerIdx] = card;
      removeFromHand(p, [cardId]);
      p.hand.push(joker);
    } else if (canAppend(meld, card)) {
      removeFromHand(p, [cardId]);
      meld.push(card);
    } else {
      socket.emit("err","Ta karta ne može ići u tu kombinaciju.");
      return;
    }

    // NE endRound — igrač mora još baciti kartu
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

    // Pravilo otpada: moraš se otvoriti ovaj red
    if (room.mustOpenThisTurn && !p.opened) {
      socket.emit("err","Uzeo si s otpada — moraš se otvoriti ovaj red!");
      return;
    }

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
      stopBotChat(room);
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

  // ── LEAVE ROOM ──────────────────────────────────────────────
  socket.on("leaveRoom", (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    const idx = room.players.findIndex(pl => pl.id === socket.id);
    if (idx === -1) return;
    const p = room.players[idx];

    io.to(roomId).emit("chat", { system: true, text: `${p.name} je napustio sobu.` });

    // Makni igrača iz sobe
    room.players.splice(idx, 1);
    socket.leave(roomId);
    socket.data.roomId = null;
    localStorage && delete socket.data.roomId;

    // Obriši sobu ako je prazna (bez ljudskih igrača)
    if (room.players.filter(pl => !pl.isBot).length === 0) {
      stopBotChat(room);
      delete rooms[roomId];
      return;
    }

    // Prenesi host
    if (room.host === socket.id) {
      const newHost = room.players.find(pl => !pl.isBot && pl.connected);
      if (newHost) {
        room.host = newHost.id;
        io.to(newHost.id).emit("youAreHost");
      }
    }

    // Ako je igra u tijeku i bio je na redu — preskoči
    if (room.phase !== "lobby" && room.phase !== "ended") {
      // Popravi turn index ako je potrebno
      if (room.turn >= room.players.length) room.turn = 0;
      // Nađi sljedećeg aktivnog
      nextTurn(room);
      broadcastState(room);
      room.players.forEach(pl => sendHand(room, pl));
    } else {
      broadcastState(room);
    }
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

/**
 * Pronalazi konkretne meld grupe za otvaranje (≥51 prirodnih bodova,
 * 1–3 melda, uz zadržavanje min. 1 karte za bacanje).
 * Vraća niz meld grupa ili null. Ista logika koristi se i za provjeru i za bot igru.
 */
function findOpeningMeldsFor(hand) {
  const all = [];
  const cap = Math.min(hand.length - 1, 7);
  for (let size = 3; size <= cap; size++) {
    for (const combo of cardCombinations(hand, size)) {
      if (isValidMeld(combo)) all.push(combo);
    }
  }
  if (all.length === 0) return null;

  // 1 meld ≥51
  const single = all.find(c => naturalPoints(c) >= MIN_OPEN);
  if (single) return [single];

  // 2 melda zajedno ≥51
  for (let i = 0; i < all.length; i++) {
    const ids1 = new Set(all[i].map(c => c.id));
    for (let j = i + 1; j < all.length; j++) {
      if (all[j].some(c => ids1.has(c.id))) continue;
      const used = all[i].length + all[j].length;
      if (naturalPoints(all[i]) + naturalPoints(all[j]) >= MIN_OPEN && used < hand.length)
        return [all[i], all[j]];
    }
  }

  // 3 melda zajedno ≥51
  for (let i = 0; i < all.length; i++) {
    const ids1 = new Set(all[i].map(c => c.id));
    for (let j = i + 1; j < all.length; j++) {
      if (all[j].some(c => ids1.has(c.id))) continue;
      const ids12 = new Set([...ids1, ...all[j].map(c => c.id)]);
      for (let k = j + 1; k < all.length; k++) {
        if (all[k].some(c => ids12.has(c.id))) continue;
        const total = naturalPoints(all[i]) + naturalPoints(all[j]) + naturalPoints(all[k]);
        const used  = all[i].length + all[j].length + all[k].length;
        if (total >= MIN_OPEN && used < hand.length) return [all[i], all[j], all[k]];
      }
    }
  }

  return null;
}

/** Provjera — može li igrač otvoriti igru s danom rukom. */
function canPlayerOpenWith(hand) {
  return findOpeningMeldsFor(hand) !== null;
}

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
