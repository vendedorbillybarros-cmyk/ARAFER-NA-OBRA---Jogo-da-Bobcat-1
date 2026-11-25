const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const PLAYER_COLORS = ['#f0821e', '#38bdf8', '#4ade80', '#c084fc'];

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Erro ao carregar o jogo.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

// rooms: Map<code, { code, status: 'lobby'|'playing'|'finished', seed, players: Map<id, playerObj> }>
const rooms = new Map();

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? genRoomCode() : code;
}

function serializePlayers(room) {
  return Array.from(room.players.values()).map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    ready: p.ready,
    isHost: p.isHost,
    alive: p.alive,
    distance: p.distance,
    y: p.y,
    duck: p.duck,
    impl: p.impl,
  }));
}

function broadcast(room, msg, excludeId = null) {
  const raw = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.id !== excludeId && p.ws.readyState === 1) {
      p.ws.send(raw);
    }
  }
}

function checkRaceOver(room) {
  if (room.status !== 'playing') return;
  const players = Array.from(room.players.values());
  if (players.length === 0) return;
  const anyAlive = players.some((p) => p.alive);
  if (!anyAlive) {
    room.status = 'finished';
    const ranking = players
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        distance: Math.floor(p.distance),
      }))
      .sort((a, b) => b.distance - a.distance);
    broadcast(room, { type: 'race_over', ranking });
  }
}

let nextClientId = 1;

wss.on('connection', (ws) => {
  const clientId = 'p' + nextClientId++;
  let currentRoom = null;

  ws.send(JSON.stringify({ type: 'welcome', id: clientId }));

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === 'create_room') {
      if (currentRoom) leaveCurrentRoom();
      const code = genRoomCode();
      const room = {
        code,
        status: 'lobby',
        seed: 0,
        players: new Map(),
      };
      const player = {
        id: clientId,
        ws,
        name: (data.name || 'Operador 1').slice(0, 16),
        color: PLAYER_COLORS[0],
        ready: true,
        isHost: true,
        alive: true,
        distance: 0,
        y: 0,
        duck: false,
        impl: null,
      };
      room.players.set(clientId, player);
      rooms.set(code, room);
      currentRoom = room;
      ws.send(JSON.stringify({
        type: 'room_joined',
        code,
        selfId: clientId,
        players: serializePlayers(room),
      }));
    }

    else if (data.type === 'join_room') {
      const code = (data.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Sala não encontrada.' }));
        return;
      }
      if (room.status !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', message: 'A corrida já começou nessa sala.' }));
        return;
      }
      if (room.players.size >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'error', message: 'Sala cheia (máximo 4 jogadores).' }));
        return;
      }
      if (currentRoom) leaveCurrentRoom();

      // Escolhe primeira cor disponível
      const usedColors = new Set(Array.from(room.players.values()).map((p) => p.color));
      const color = PLAYER_COLORS.find((c) => !usedColors.has(c)) || PLAYER_COLORS[0];

      const player = {
        id: clientId,
        ws,
        name: (data.name || `Operador ${room.players.size + 1}`).slice(0, 16),
        color,
        ready: false,
        isHost: false,
        alive: true,
        distance: 0,
        y: 0,
        duck: false,
        impl: null,
      };
      room.players.set(clientId, player);
      currentRoom = room;

      ws.send(JSON.stringify({
        type: 'room_joined',
        code,
        selfId: clientId,
        players: serializePlayers(room),
      }));
      broadcast(room, { type: 'room_update', players: serializePlayers(room) }, clientId);
    }

    else if (data.type === 'toggle_ready') {
      if (!currentRoom || currentRoom.status !== 'lobby') return;
      const p = currentRoom.players.get(clientId);
      if (!p) return;
      p.ready = !p.ready;
      broadcast(currentRoom, { type: 'room_update', players: serializePlayers(currentRoom) });
    }

    else if (data.type === 'start_game') {
      if (!currentRoom || currentRoom.status !== 'lobby') return;
      const p = currentRoom.players.get(clientId);
      if (!p || !p.isHost) return;
      const allReady = Array.from(currentRoom.players.values()).every((pl) => pl.ready);
      if (!allReady) {
        ws.send(JSON.stringify({ type: 'error', message: 'Aguardando todos os jogadores ficarem prontos.' }));
        return;
      }
      currentRoom.status = 'playing';
      currentRoom.seed = Math.floor(Math.random() * 2147483647) + 1;
      for (const pl of currentRoom.players.values()) {
        pl.alive = true;
        pl.distance = 0;
        pl.y = 0;
        pl.duck = false;
        pl.impl = null;
      }
      broadcast(currentRoom, {
        type: 'game_start',
        seed: currentRoom.seed,
        players: serializePlayers(currentRoom),
      });
    }

    else if (data.type === 'state') {
      if (!currentRoom || currentRoom.status !== 'playing') return;
      const p = currentRoom.players.get(clientId);
      if (!p) return;
      p.distance = Number(data.distance) || 0;
      p.y = Number(data.y) || 0;
      p.duck = !!data.duck;
      p.impl = data.impl || null;
      p.alive = data.alive !== false;
      broadcast(currentRoom, {
        type: 'player_state',
        id: clientId,
        distance: p.distance,
        y: p.y,
        duck: p.duck,
        impl: p.impl,
        alive: p.alive,
      }, clientId);
    }

    else if (data.type === 'died') {
      if (!currentRoom || currentRoom.status !== 'playing') return;
      const p = currentRoom.players.get(clientId);
      if (!p) return;
      p.alive = false;
      p.distance = Number(data.distance) || p.distance;
      broadcast(currentRoom, {
        type: 'player_died',
        id: clientId,
        distance: p.distance,
      }, clientId);
      checkRaceOver(currentRoom);
    }

    else if (data.type === 'back_to_lobby') {
      if (!currentRoom) return;
      if (currentRoom.status === 'finished') {
        currentRoom.status = 'lobby';
        for (const pl of currentRoom.players.values()) {
          pl.ready = pl.isHost;
          pl.alive = true;
          pl.distance = 0;
        }
        broadcast(currentRoom, { type: 'room_update', players: serializePlayers(currentRoom), backToLobby: true });
      }
    }
  });

  function leaveCurrentRoom() {
    if (!currentRoom) return;
    const room = currentRoom;
    room.players.delete(clientId);
    currentRoom = null;

    if (room.players.size === 0) {
      rooms.delete(room.code);
      return;
    }

    // Se o host saiu, promove o próximo
    const hasHost = Array.from(room.players.values()).some((p) => p.isHost);
    if (!hasHost) {
      const nextHost = room.players.values().next().value;
      if (nextHost) {
        nextHost.isHost = true;
        nextHost.ready = true;
      }
    }

    broadcast(room, { type: 'room_update', players: serializePlayers(room) });
    if (room.status === 'playing') {
      checkRaceOver(room);
    }
  }

  ws.on('close', () => {
    leaveCurrentRoom();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor Arafer na Obra Multiplayer rodando em http://0.0.0.0:${PORT}`);
});
