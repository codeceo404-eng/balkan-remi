const socket = io();

const joinBtn = document.getElementById('joinBtn');
const roomInput = document.getElementById('roomInput');
const handDiv = document.getElementById('hand');
const opponentDiv = document.getElementById('opponent');

let myHand = [];

joinBtn.onclick = () => {
  const room = roomInput.value.trim();
  if (!room) return;
  socket.emit('joinRoom', room);
};

socket.on('startGame', (hands) => {
  myHand = hands[socket.id];
  renderHand();
});

function renderHand() {
  handDiv.innerHTML = '';
  myHand.forEach((card, idx) => {
    const btn = document.createElement('button');
    btn.textContent = `${card.value}${card.suit}`;
    btn.onclick = () => playCard(idx);
    handDiv.appendChild(btn);
  });
}

function playCard(idx) {
  const card = myHand.splice(idx, 1)[0];
  renderHand();
  opponentDiv.textContent = `Igrač je bacio: ${card.value}${card.suit}`;
  socket.emit('playCard', {room: roomInput.value, card});
}

socket.on('opponentPlayed', (card) => {
  opponentDiv.textContent = `Protivnik je bacio: ${card.value}${card.suit}`;
});
