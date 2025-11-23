const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Serve static client files
app.use(express.static(path.join(__dirname, 'public')));

const players = new Map();
const enemies = new Map();

const ARENA = { width: 800, height: 600, padding: 20 };
const ENEMY_SPEED = 80; // px/s
const WAVE_SIZE = 5;
const WAVE_INTERVAL_MS = 10000;
const ENEMY_TICK_MS = 100;
const ENEMY_DESPAWN_MS = 30000;

const loopState = {
  waveIntervalId: null,
  enemyIntervalId: null,
  lastEnemyTick: Date.now(),
};

const createPlayer = (id) => ({
  id,
  x: Math.floor(Math.random() * (ARENA.width - ARENA.padding * 2)) + ARENA.padding,
  y: Math.floor(Math.random() * (ARENA.height - ARENA.padding * 2)) + ARENA.padding,
});

const createEnemy = () => {
  const now = Date.now();
  const id = `enemy-${now}-${Math.floor(Math.random() * 10000)}`;
  return {
    id,
    x: Math.floor(Math.random() * (ARENA.width - ARENA.padding * 2)) + ARENA.padding,
    y: Math.floor(Math.random() * (ARENA.height - ARENA.padding * 2)) + ARENA.padding,
    createdAt: now,
  };
};

const emitEnemies = () => {
  io.emit('enemiesUpdated', Array.from(enemies.values()));
};

const spawnEnemyWave = (count = WAVE_SIZE) => {
  for (let i = 0; i < count; i += 1) {
    const enemy = createEnemy();
    enemies.set(enemy.id, enemy);
  }
  emitEnemies();
};

const despawnEnemies = (now) => {
  let removed = false;
  enemies.forEach((enemy, id) => {
    if (now - enemy.createdAt >= ENEMY_DESPAWN_MS) {
      enemies.delete(id);
      removed = true;
    }
  });
  if (removed) emitEnemies();
};

const moveEnemies = () => {
  if (players.size === 0 || enemies.size === 0) return;
  const now = Date.now();
  const deltaSeconds = Math.max((now - loopState.lastEnemyTick) / 1000, 0);
  loopState.lastEnemyTick = now;

  enemies.forEach((enemy) => {
    let closest = null;
    let closestDistSq = Number.POSITIVE_INFINITY;
    players.forEach((player) => {
      const dx = player.x - enemy.x;
      const dy = player.y - enemy.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < closestDistSq) {
        closestDistSq = distSq;
        closest = player;
      }
    });
    if (!closest) return;
    const dirX = closest.x - enemy.x;
    const dirY = closest.y - enemy.y;
    const len = Math.hypot(dirX, dirY) || 1;
    const normX = dirX / len;
    const normY = dirY / len;
    enemy.x += normX * ENEMY_SPEED * deltaSeconds;
    enemy.y += normY * ENEMY_SPEED * deltaSeconds;
    enemy.x = Math.max(ARENA.padding, Math.min(ARENA.width - ARENA.padding, enemy.x));
    enemy.y = Math.max(ARENA.padding, Math.min(ARENA.height - ARENA.padding, enemy.y));
  });

  despawnEnemies(now);
  emitEnemies();
};

const startGameLoops = () => {
  if (loopState.waveIntervalId || loopState.enemyIntervalId) return;
  loopState.lastEnemyTick = Date.now();
  spawnEnemyWave();
  loopState.waveIntervalId = setInterval(spawnEnemyWave, WAVE_INTERVAL_MS);
  loopState.enemyIntervalId = setInterval(moveEnemies, ENEMY_TICK_MS);
};

const stopGameLoops = () => {
  if (loopState.waveIntervalId) clearInterval(loopState.waveIntervalId);
  if (loopState.enemyIntervalId) clearInterval(loopState.enemyIntervalId);
  loopState.waveIntervalId = null;
  loopState.enemyIntervalId = null;
};

const setupSocketHandlers = (ioInstance) => {
  ioInstance.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    const player = createPlayer(socket.id);
    players.set(socket.id, player);
    if (players.size === 1) startGameLoops();

    // Send full state to the newly connected client
    socket.emit('currentPlayers', Array.from(players.values()));
    socket.emit('currentEnemies', Array.from(enemies.values()));

    // Inform others about the newcomer
    socket.broadcast.emit('newPlayer', player);

    socket.on('playerMovement', (data) => {
      const existing = players.get(socket.id);
      if (!existing || typeof data !== 'object') return;
      const { x, y } = data;
      existing.x = x;
      existing.y = y;
      // Broadcast to everyone except sender
      socket.broadcast.emit('playerMoved', existing);
    });

    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
      players.delete(socket.id);
      socket.broadcast.emit('playerDisconnected', { id: socket.id });
      if (players.size === 0) {
        stopGameLoops();
        enemies.clear();
        emitEnemies();
      }
    });
  });
};

setupSocketHandlers(io);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
