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

// --- Constants ---
const ARENA = { width: 800, height: 600, padding: 20 };
const PLAYER_MAX_HP = 100;
const ENEMY_MAX_HP = 10;
const PLAYER_HIT_DISTANCE = 30;
const PLAYER_HIT_DAMAGE = 5;
const ENEMY_SPEED = 80; // px/s
const PROJECTILE_SPEED = 320; // px/s
const PROJECTILE_DAMAGE_BASE = 5;
const PROJECTILE_DAMAGE_PER_LEVEL = 2;
const PROJECTILE_RANGE = 600;
const PROJECTILE_HIT_DISTANCE = 20;
const ENEMY_TICK_MS = 100;
const ENEMY_DESPAWN_MS = 30000;
const MAX_WAVE = 5;
const UPGRADE_COST = 5;
const MAX_WEAPON_LEVEL = 5;
const SHOP_PHASE_MS = 5000;
const GATE = {
  x: ARENA.width / 2,
  y: 40,
  spread: 60,
};

// --- State ---
const rooms = new Map();

const randomInArena = () => ({
  x: Math.floor(Math.random() * (ARENA.width - ARENA.padding * 2)) + ARENA.padding,
  y: Math.floor(Math.random() * (ARENA.height - ARENA.padding * 2)) + ARENA.padding,
});

const generateRoomId = () => {
  const code = () => Math.random().toString(36).substr(2, 4).toUpperCase();
  let id = code();
  while (rooms.has(id)) id = code();
  return id;
};

// --- Helpers ---
const createPlayer = (id, name) => {
  const pos = randomInArena();
  return {
    id,
    name: name || 'Hero',
    ...pos,
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    isDead: false,
    coins: 0,
    weaponLevel: 1,
    isReady: false,
    isHost: false,
  };
};

const createEnemy = (wave) => {
  const now = Date.now();
  const pos = randomInArena();
  return {
    id: `enemy-${now}-${Math.floor(Math.random() * 10000)}`,
    ...pos,
    createdAt: now,
    hp: ENEMY_MAX_HP,
    maxHp: ENEMY_MAX_HP,
    wave,
  };
};

const createProjectile = (player, dir) => {
  const len = Math.hypot(dir.x, dir.y) || 1;
  const norm = { x: dir.x / len, y: dir.y / len };
  return {
    id: `proj-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    playerId: player.id,
    x: player.x,
    y: player.y,
    vx: norm.x * PROJECTILE_SPEED,
    vy: norm.y * PROJECTILE_SPEED,
    spawnTime: Date.now(),
    damage: PROJECTILE_DAMAGE_BASE + (player.weaponLevel - 1) * PROJECTILE_DAMAGE_PER_LEVEL,
  };
};

const createRoom = (roomId) => ({
  id: roomId,
  hostId: null,
  players: new Map(),
  enemies: new Map(),
  projectiles: new Map(),
  coins: new Map(),
  waveNumber: 0,
  running: false,
  phase: 'lobby', // 'lobby' | 'combat' | 'shop'
  loops: {
    enemyIntervalId: null,
    lastEnemyTick: Date.now(),
    nextWaveTimeoutId: null,
  },
  upgradePad: {
    x: ARENA.width / 2,
    y: ARENA.height / 2,
    radius: 30,
  },
});

const emitRoomState = (room) => {
  const payload = {
    roomId: room.id,
    hostId: room.hostId,
    wave: room.waveNumber,
    running: room.running,
    players: Array.from(room.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      isReady: p.isReady,
      isHost: p.isHost,
      hp: p.hp,
      maxHp: p.maxHp,
      isDead: p.isDead,
      coins: p.coins,
      weaponLevel: p.weaponLevel,
      x: p.x,
      y: p.y,
    })),
  };
  io.to(room.id).emit('roomState', payload);
};

const emitEnemies = (room) => {
  io.to(room.id).emit('enemiesUpdated', Array.from(room.enemies.values()));
};

const emitProjectiles = (room) => {
  io.to(room.id).emit('projectilesUpdated', Array.from(room.projectiles.values()));
};

const emitCoins = (room) => {
  io.to(room.id).emit('coinsUpdated', Array.from(room.coins.values()));
};

const alivePlayers = (room) => Array.from(room.players.values()).filter((p) => !p.isDead);

const handleGameOver = (room, reason) => {
  room.running = false;
  clearInterval(room.loops.enemyIntervalId);
  if (room.loops.nextWaveTimeoutId) clearTimeout(room.loops.nextWaveTimeoutId);
  room.loops.enemyIntervalId = null;
  room.loops.nextWaveTimeoutId = null;
  io.to(room.id).emit('gameOver', { wave: room.waveNumber, reason });
  // Reset for lobby
  room.phase = 'lobby';
  room.waveNumber = 0;
  room.enemies.clear();
  room.projectiles.clear();
  room.coins.clear();
  room.players.forEach((p) => {
    p.isDead = false;
    p.isReady = false;
    p.hp = PLAYER_MAX_HP;
    p.maxHp = PLAYER_MAX_HP;
    p.coins = 0;
    p.weaponLevel = 1;
  });
  emitEnemies(room);
  emitProjectiles(room);
  emitCoins(room);
  emitRoomState(room);
};

// --- Game logic ---
const spawnEnemyWave = (room) => {
  if (!room.running) return;
  if (room.waveNumber >= MAX_WAVE) {
    handleGameOver(room, 'waves-cleared');
    return;
  }
  room.waveNumber += 1;
  const count = Math.min(room.waveNumber * 2, 20);
  for (let i = 0; i < count; i += 1) {
    const enemy = createEnemy(room.waveNumber);
    // Override random position with gate position
    const offsetX = (Math.random() - 0.5) * GATE.spread;
    enemy.x = GATE.x + offsetX;
    enemy.y = GATE.y;
    room.enemies.set(enemy.id, enemy);
  }
  emitEnemies(room);
  io.to(room.id).emit('waveUpdated', { wave: room.waveNumber });

  // Two-step spawn: freeze enemies for a short time so players see where they come from
  room.phase = 'spawning';
  if (room.loops.nextWaveTimeoutId) clearTimeout(room.loops.nextWaveTimeoutId);
  room.loops.nextWaveTimeoutId = setTimeout(() => {
    if (!room.running) return;
    room.phase = 'combat';
    // Reset enemy tick timestamp so they DON'T jump after spawn pause
    room.loops.lastEnemyTick = Date.now();
  }, 2000);
};

const despawnEnemies = (room, now) => {
  let removed = false;
  room.enemies.forEach((enemy, id) => {
    if (now - enemy.createdAt >= ENEMY_DESPAWN_MS) {
      room.enemies.delete(id);
      removed = true;
    }
  });
  if (removed) emitEnemies(room);
};

// Server-authoritative melee damage: any enemy within range chips away player HP.
const applyEnemyDamageToPlayers = (room) => {
  if (room.players.size === 0 || room.enemies.size === 0) return;
  const rangeSq = PLAYER_HIT_DISTANCE * PLAYER_HIT_DISTANCE;
  const damageMap = new Map();
  room.enemies.forEach((enemy) => {
    room.players.forEach((player) => {
      if (player.isDead) return;
      const dx = player.x - enemy.x;
      const dy = player.y - enemy.y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= rangeSq) {
        const current = damageMap.get(player.id) || 0;
        damageMap.set(player.id, current + PLAYER_HIT_DAMAGE);
      }
    });
  });
  if (damageMap.size === 0) return;
  const hpUpdates = [];
  const deadPlayers = [];
  damageMap.forEach((damage, playerId) => {
    const player = room.players.get(playerId);
    if (!player || player.isDead) return;
    player.hp = Math.max(0, player.hp - damage);
    hpUpdates.push({ id: player.id, hp: player.hp, maxHp: player.maxHp });
    if (player.hp === 0) {
      player.isDead = true;
      deadPlayers.push({ id: player.id });
    }
  });
  if (hpUpdates.length > 0) io.to(room.id).emit('playerHpUpdated', hpUpdates);
  deadPlayers.forEach((dead) => io.to(room.id).emit('playerDied', dead));
};

const moveEnemies = (room) => {
  if (!room.running || room.phase !== 'combat') return;
  const now = Date.now();
  const deltaSeconds = Math.max((now - room.loops.lastEnemyTick) / 1000, 0);
  room.loops.lastEnemyTick = now;

  const alive = alivePlayers(room);
  if (alive.length === 0) {
    handleGameOver(room, 'all-dead');
    return;
  }

  room.enemies.forEach((enemy) => {
    let closest = null;
    let closestDistSq = Number.POSITIVE_INFINITY;
    alive.forEach((player) => {
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
    enemy.x += (dirX / len) * ENEMY_SPEED * deltaSeconds;
    enemy.y += (dirY / len) * ENEMY_SPEED * deltaSeconds;
    enemy.x = Math.max(ARENA.padding, Math.min(ARENA.width - ARENA.padding, enemy.x));
    enemy.y = Math.max(ARENA.padding, Math.min(ARENA.height - ARENA.padding, enemy.y));
  });

  despawnEnemies(room, now);
  emitEnemies(room);
  applyEnemyDamageToPlayers(room);
};

const moveProjectiles = (room) => {
  if (!room.running || room.projectiles.size === 0) return;
  const now = Date.now();
  const toRemove = [];
  room.projectiles.forEach((proj, id) => {
    const deltaSeconds = ENEMY_TICK_MS / 1000;
    proj.x += proj.vx * deltaSeconds;
    proj.y += proj.vy * deltaSeconds;
    const traveled = Math.hypot(proj.x, proj.y);
    const lifetime = now - proj.spawnTime;
    if (
      proj.x < 0 || proj.x > ARENA.width ||
      proj.y < 0 || proj.y > ARENA.height ||
      lifetime > (PROJECTILE_RANGE / PROJECTILE_SPEED) * 1000
    ) {
      toRemove.push(id);
    }
  });

  // Collision vs enemies
  room.projectiles.forEach((proj, projId) => {
    let hitId = null;
    room.enemies.forEach((enemy, enemyId) => {
      const dx = enemy.x - proj.x;
      const dy = enemy.y - proj.y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= PROJECTILE_HIT_DISTANCE * PROJECTILE_HIT_DISTANCE) {
        hitId = enemyId;
      }
    });
    if (hitId) {
      const enemy = room.enemies.get(hitId);
      if (enemy) {
        enemy.hp = Math.max(0, enemy.hp - proj.damage);
        if (enemy.hp === 0) {
          room.enemies.delete(hitId);
          // Coin drop at enemy position
          const coinId = `coin-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
          room.coins.set(coinId, { id: coinId, x: enemy.x, y: enemy.y, value: 1 });
          emitCoins(room);
        }
      }
      toRemove.push(projId);
    }
  });

  toRemove.forEach((id) => room.projectiles.delete(id));
  emitProjectiles(room);
  emitEnemies(room);
};

const pickupCoins = (room) => {
  if (room.coins.size === 0 || room.players.size === 0) return;
  const toRemove = [];
  const updates = [];
  room.coins.forEach((coin, id) => {
    room.players.forEach((player) => {
      if (player.isDead) return;
      const dx = player.x - coin.x;
      const dy = player.y - coin.y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= PLAYER_HIT_DISTANCE * PLAYER_HIT_DISTANCE) {
        player.coins += coin.value;
        updates.push({ id: player.id, coins: player.coins, weaponLevel: player.weaponLevel });
        toRemove.push(id);
      }
    });
  });
  toRemove.forEach((id) => room.coins.delete(id));
  if (updates.length > 0) io.to(room.id).emit('playerStatsUpdated', updates);
  if (toRemove.length > 0) emitCoins(room);
};

const applyUpgradePad = (room) => {
  const updates = [];
  room.players.forEach((player) => {
    if (player.isDead) return;
    if (player.weaponLevel >= MAX_WEAPON_LEVEL) return;
    const dx = player.x - room.upgradePad.x;
    const dy = player.y - room.upgradePad.y;
    const distSq = dx * dx + dy * dy;
    if (distSq <= room.upgradePad.radius * room.upgradePad.radius) {
      if (player.coins >= UPGRADE_COST) {
        player.coins -= UPGRADE_COST;
        player.weaponLevel += 1;
        updates.push({ id: player.id, coins: player.coins, weaponLevel: player.weaponLevel });
      }
    }
  });
  if (updates.length > 0) io.to(room.id).emit('playerStatsUpdated', updates);
};

const startShopPhase = (room) => {
  room.phase = 'shop';
  io.to(room.id).emit('waveCleared', {
    wave: room.waveNumber,
    nextWaveInMs: SHOP_PHASE_MS,
    maxWave: MAX_WAVE,
  });

  if (room.loops.nextWaveTimeoutId) clearTimeout(room.loops.nextWaveTimeoutId);
  room.loops.nextWaveTimeoutId = setTimeout(() => {
    if (!room.running) return;
    room.phase = 'combat';
    spawnEnemyWave(room);
  }, SHOP_PHASE_MS);
};

const startRoomLoops = (room) => {
  if (room.running) return;
  room.running = true;
  room.phase = 'combat';
  room.waveNumber = 0;
  room.enemies.clear();
  room.projectiles.clear();
  room.coins.clear();
  room.players.forEach((p) => {
    const pos = randomInArena();
    p.x = pos.x;
    p.y = pos.y;
    p.hp = PLAYER_MAX_HP;
    p.maxHp = PLAYER_MAX_HP;
    p.isDead = false;
    p.coins = 0;
    p.weaponLevel = 1;
    p.isReady = false;
  });
  room.loops.lastEnemyTick = Date.now();
  spawnEnemyWave(room);
  // room.loops.waveIntervalId = setInterval(() => spawnEnemyWave(room), WAVE_INTERVAL_MS);
  room.loops.enemyIntervalId = setInterval(() => {
    moveEnemies(room);
    moveProjectiles(room);
    pickupCoins(room);
    applyUpgradePad(room);
    const alive = alivePlayers(room);
    if (alive.length === 0) handleGameOver(room, 'all-dead');

    // Check for wave clear
    if (room.phase === 'combat' && room.enemies.size === 0) {
      if (room.waveNumber >= MAX_WAVE) {
        handleGameOver(room, 'waves-cleared');
      } else {
        startShopPhase(room);
      }
    }
  }, ENEMY_TICK_MS);
  io.to(room.id).emit('currentPlayers', Array.from(room.players.values()));
  io.to(room.id).emit('gameStarted', { wave: room.waveNumber });
  emitRoomState(room);
};

const stopRoomLoops = (room) => {
  clearInterval(room.loops.enemyIntervalId);
  if (room.loops.nextWaveTimeoutId) clearTimeout(room.loops.nextWaveTimeoutId);
  room.loops.enemyIntervalId = null;
  room.loops.nextWaveTimeoutId = null;
  room.running = false;
};

// --- Socket wiring ---
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  socket.data.roomId = null;

  const leaveRoom = () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.players.delete(socket.id);
    socket.leave(roomId);
    if (room.hostId === socket.id) {
      const nextHost = room.players.keys().next().value;
      room.hostId = nextHost || null;
      if (nextHost) {
        const host = room.players.get(nextHost);
        if (host) host.isHost = true;
      }
    }
    if (room.players.size === 0) {
      stopRoomLoops(room);
      rooms.delete(roomId);
      return;
    }
    emitRoomState(room);
  };

  socket.on('createRoom', ({ name }) => {
    const roomId = generateRoomId();
    const room = createRoom(roomId);
    rooms.set(roomId, room);
    const player = createPlayer(socket.id, name);
    player.isHost = true;
    room.hostId = socket.id;
    room.players.set(socket.id, player);
    socket.join(roomId);
    socket.data.roomId = roomId;
    emitRoomState(room);
    socket.emit('roomJoined', { roomId });
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('errorMessage', { message: 'Room not found' });
      return;
    }
    const player = createPlayer(socket.id, name);
    player.isHost = false;
    room.players.set(socket.id, player);
    socket.join(roomId);
    socket.data.roomId = roomId;
    emitRoomState(room);
    socket.emit('roomJoined', { roomId });
  });

  socket.on('playerReady', ({ ready }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.isReady = !!ready;
    emitRoomState(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || room.hostId !== socket.id) return;
    const hasReady = Array.from(room.players.values()).some((p) => p.isReady);
    if (!hasReady) {
      socket.emit('errorMessage', { message: 'No ready players' });
      return;
    }
    startRoomLoops(room);
  });

  socket.on('playerMovement', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.running) return;
    const existing = room.players.get(socket.id);
    if (!existing || typeof data !== 'object' || existing.isDead) return;
    const { x, y } = data;
    existing.x = x;
    existing.y = y;
    // Broadcast to room except sender
    socket.to(room.id).emit('playerMoved', existing);
  });

  socket.on('playerShoot', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.running) return;
    const player = room.players.get(socket.id);
    if (!player || player.isDead) return;
    const dir = data && typeof data === 'object' ? data : null;
    if (!dir || typeof dir.x !== 'number' || typeof dir.y !== 'number') return;
    const proj = createProjectile(player, dir);
    room.projectiles.set(proj.id, proj);
    emitProjectiles(room);
  });

  socket.on('disconnect', () => {
    leaveRoom();
    console.log(`Client disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
