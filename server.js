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

// Serve map editor
app.get('/mapeditor', (req, res) => {
  res.sendFile(path.join(__dirname, 'mapeditor.html'));
});

// --- Constants ---
// --- Constants ---
const levelConfig = require(path.join(__dirname, 'public', 'config', 'level.json'));

const ARENA = { ...levelConfig.arena, padding: 20 };
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
const MAX_STAT_LEVEL = 5;
const SHOP_PHASE_MS = 5000;
const GATE = {
  x: ARENA.width / 2,
  y: 40,
  spread: 120, // Increased spread for larger arena
};

const BASE = {
  x: levelConfig.base.x,
  y: levelConfig.base.y,
  maxHp: 100,
};

// Enemy Paths from config
const PATH_LEFT = (levelConfig.enemyPaths && levelConfig.enemyPaths.left) || [];
const PATH_RIGHT = (levelConfig.enemyPaths && levelConfig.enemyPaths.right) || [];

const ENEMY_VISION_RADIUS = 200; // New constant for enemy vision
const ENEMY_LOSE_PLAYER_RADIUS = 260;
const ENEMY_BASE_CONTACT_DISTANCE = 40;
const BASE_DAMAGE_PER_TICK = 3;

// Server-side wall constraints (matching client LEVEL_WALLS)
const LANE_WALLS = levelConfig.walls;

const MAX_PLAYERS_PER_ROOM = (levelConfig.playerSpawns && levelConfig.playerSpawns.length) || 8;

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
  // Initial position will be set when game starts/restarts
  // For lobby, we can just put them in center or random
  const pos = randomInArena();
  return {
    id,
    name: name || 'Hero',
    ...pos,
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    isDead: false,
    coins: 0,
    armorLevel: 1,
    attackLevel: 1,
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
    mode: 'path',
    pathIndex: 0,
    chaseTargetId: null,
    pathNodes: null, // Will be assigned at spawn
  };
};

const constrainToLane = (x, y) => {
  // Simple constraint: keep within arena and roughly away from walls
  // For a prototype, use a simple center-bias approach
  let newX = Math.max(ARENA.padding + 50, Math.min(ARENA.width - ARENA.padding - 50, x));
  let newY = Math.max(ARENA.padding + 50, Math.min(ARENA.height - ARENA.padding - 50, y));

  // Check collision with walls and push out if needed
  for (const wall of LANE_WALLS) {
    // Simple AABB overlap check with 20px buffer
    const buffer = 20;
    if (newX + buffer > wall.x && newX - buffer < wall.x + wall.width &&
      newY + buffer > wall.y && newY - buffer < wall.y + wall.height) {
      // Push out to nearest edge
      const pushLeft = Math.abs(newX - (wall.x + wall.width));
      const pushRight = Math.abs(newX - wall.x);
      const pushUp = Math.abs(newY - (wall.y + wall.height));
      const pushDown = Math.abs(newY - wall.y);

      const minPush = Math.min(pushLeft, pushRight, pushUp, pushDown);
      if (minPush === pushLeft) newX = wall.x + wall.width + buffer;
      else if (minPush === pushRight) newX = wall.x - buffer;
      else if (minPush === pushUp) newY = wall.y + wall.height + buffer;
      else newY = wall.y - buffer;
    }
  }

  return { x: newX, y: newY };
};

const createProjectile = (player, dir) => {
  const len = Math.hypot(dir.x, dir.y);
  if (len === 0) return null;
  const norm = { x: dir.x / len, y: dir.y / len };
  return {
    id: `proj-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    playerId: player.id,
    x: player.x,
    y: player.y,
    vx: norm.x * PROJECTILE_SPEED,
    vy: norm.y * PROJECTILE_SPEED,
    spawnTime: Date.now(),
    damage: PROJECTILE_DAMAGE_BASE * player.attackLevel,
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
  phase: 'lobby', // 'lobby', 'combat', 'shop', 'spawning'
  baseHp: BASE.maxHp,
  baseMaxHp: BASE.maxHp,
  enemySpawnCount: 0, // For alternating path assignment
  loops: {
    enemyIntervalId: null,
    lastEnemyTick: Date.now(),
    nextWaveTimeoutId: null,
  },
  armorPad: {
    x: levelConfig.armorPad.x,
    y: levelConfig.armorPad.y,
    radius: levelConfig.armorPad.radius,
  },
  attackPad: {
    x: levelConfig.attackPad.x,
    y: levelConfig.attackPad.y,
    radius: levelConfig.attackPad.radius,
  },
});

const emitRoomState = (room) => {
  const payload = {
    roomId: room.id,
    hostId: room.hostId,
    wave: room.waveNumber,
    running: room.running,
    baseHp: room.baseHp,
    baseMaxHp: room.baseMaxHp,
    players: Array.from(room.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      isReady: p.isReady,
      isHost: p.isHost,
      hp: p.hp,
      maxHp: p.maxHp,
      isDead: p.isDead,
      coins: p.coins,
      armorLevel: p.armorLevel,
      attackLevel: p.attackLevel,
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
    p.armorLevel = 1;
    p.attackLevel = 1;
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

    const leftPath = PATH_LEFT;
    const rightPath = PATH_RIGHT;

    // Alternate: left/right
    const useLeft = room.enemySpawnCount % 2 === 0;
    room.enemySpawnCount++;

    enemy.pathNodes = useLeft ? leftPath : rightPath;

    // Start position: first path node, or fallback to gate if no nodes
    const nodes = enemy.pathNodes;
    if (nodes && nodes.length > 0) {
      enemy.x = nodes[0].x;
      enemy.y = nodes[0].y;
    } else {
      const offsetX = (Math.random() - 0.5) * GATE.spread;
      enemy.x = GATE.x + offsetX;
      enemy.y = GATE.y;
    }

    enemy.mode = 'path';
    enemy.pathIndex = 0; // Start at first node (already there, so will move to next)

    // If we spawn exactly at node 0, we should probably target node 1 immediately
    // But the movement logic handles "close enough to node" check, so it's fine.
    // Actually, if we spawn AT node 0, we should target node 1.
    // Let's just let the loop handle it.

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

const restartGame = (room) => {
  if (room.running) return;
  stopRoomLoops(room);

  // Reset room state
  room.waveNumber = 0;
  room.enemies.clear();
  room.projectiles.clear();
  room.coins.clear();
  room.baseHp = BASE.maxHp;
  room.baseMaxHp = BASE.maxHp;
  room.phase = 'combat';

  // Reset players
  const spawns = levelConfig.playerSpawns && levelConfig.playerSpawns.length
    ? levelConfig.playerSpawns
    : [{ x: ARENA.width / 2, y: ARENA.height / 2 }];

  let index = 0;
  room.players.forEach((p) => {
    const spawn = spawns[index % spawns.length];
    p.x = spawn.x;
    p.y = spawn.y;
    index++;

    p.hp = PLAYER_MAX_HP;
    p.maxHp = PLAYER_MAX_HP;
    p.isDead = false;
    p.coins = 0;
    p.armorLevel = 1;
    p.attackLevel = 1;
    p.isReady = true; // Auto-ready for restart
  });

  startRoomLoops(room);
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
    const damageTaken = Math.max(1, Math.round(damage / player.armorLevel));
    player.hp = Math.max(0, player.hp - damageTaken);
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
  if (room.phase !== 'combat') return;
  const now = Date.now();
  const deltaSeconds = (now - room.loops.lastEnemyTick) / 1000;
  room.loops.lastEnemyTick = now;

  const enemiesToRemove = [];

  room.enemies.forEach((enemy) => {
    if (enemy.isDead) return;

    let targetX = enemy.x;
    let targetY = enemy.y;
    let move = true;

    // State Machine
    switch (enemy.mode) {
      case 'path':
        if (enemy.pathNodes && enemy.pathIndex < enemy.pathNodes.length) {
          const node = enemy.pathNodes[enemy.pathIndex];
          targetX = node.x;
          targetY = node.y;
          const distSq = (targetX - enemy.x) ** 2 + (targetY - enemy.y) ** 2;
          if (distSq < 100) { // reached node
            enemy.pathIndex++;
            if (enemy.pathIndex >= enemy.pathNodes.length) {
              enemy.mode = 'goal';
            }
          }
        } else {
          enemy.mode = 'goal';
        }
        break;

      case 'chase': {
        // Find closest player
        let closest = null;
        let minDistSq = Infinity;
        for (const p of room.players.values()) {
          if (p.isDead) continue;
          const d2 = (p.x - enemy.x) ** 2 + (p.y - enemy.y) ** 2;
          if (d2 < minDistSq) {
            minDistSq = d2;
            closest = p;
          }
        }
        if (closest && minDistSq < ENEMY_VISION_RADIUS * ENEMY_VISION_RADIUS) {
          targetX = closest.x;
          targetY = closest.y;
        } else {
          // Lost target -> go back to path or goal
          const hasPath = enemy.pathNodes && enemy.pathNodes.length > 0;
          enemy.mode = hasPath && enemy.pathIndex < enemy.pathNodes.length ? 'path' : 'goal';
        }
        break;
      }

      case 'goal': {
        targetX = BASE.x;
        targetY = BASE.y;
        const dx = targetX - enemy.x;
        const dy = targetY - enemy.y;
        const distSq = dx * dx + dy * dy;
        if (distSq <= ENEMY_BASE_CONTACT_DISTANCE * ENEMY_BASE_CONTACT_DISTANCE) {
          // One-shot base damage
          const oldHp = room.baseHp;
          room.baseHp = Math.max(0, room.baseHp - BASE_DAMAGE_PER_TICK);

          if (room.baseHp !== oldHp) {
            io.to(room.id).emit('baseHpUpdated', {
              baseHp: room.baseHp,
              baseMaxHp: room.baseMaxHp,
            });
          }

          // Mark enemy for removal
          enemiesToRemove.push(enemy.id);
          move = false; // no further movement this tick
        }
        break;
      }

      // 'attackBase' is no longer used
    }

    // Check for players to chase (override path/goal)
    if (enemy.mode !== 'chase' && enemy.mode !== 'goal') { // Don't switch to chase if attacking base (though goal now removes enemy)
      // Actually, if in 'goal' mode (heading to base), we might still want to chase?
      // The prompt says: "enemies have a mode state machine (path, goal, chase, attackBase)"
      // And "when they reach the base, they switch to attackBase" -> changed to "sacrifice"
      // Let's keep the chase logic simple: if close to player, chase.
      // But maybe not if they are very close to base?
      // For now, let's keep existing logic but update the "return to path" part

      let closest = null;
      let minDistSq = Infinity;
      for (const p of room.players.values()) {
        if (p.isDead) continue;
        const d2 = (p.x - enemy.x) ** 2 + (p.y - enemy.y) ** 2;
        if (d2 < minDistSq) {
          minDistSq = d2;
          closest = p;
        }
      }
      if (closest && minDistSq < ENEMY_VISION_RADIUS * ENEMY_VISION_RADIUS) {
        enemy.mode = 'chase';
      }
    }

    if (move) {
      const dx = targetX - enemy.x;
      const dy = targetY - enemy.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1) {
        let nextX = enemy.x + (dx / dist) * ENEMY_SPEED * deltaSeconds;
        let nextY = enemy.y + (dy / dist) * ENEMY_SPEED * deltaSeconds;

        // Apply lane constraints
        const constrained = constrainToLane(nextX, nextY);
        enemy.x = constrained.x;
        enemy.y = constrained.y;
      } else {
        // If very close to target, snap to target to avoid jitter
        enemy.x = targetX;
        enemy.y = targetY;
      }
    } else {
      // Even if not moving, ensure position is valid
      const constrained = constrainToLane(enemy.x, enemy.y);
      enemy.x = constrained.x;
      enemy.y = constrained.y;
    }
  });

  // Remove sacrificed enemies
  enemiesToRemove.forEach((id) => {
    room.enemies.delete(id);
  });

  applyEnemyDamageToPlayers(room);

  if (room.baseHp === 0) {
    handleGameOver(room, 'base-destroyed');
    return;
  }
  emitEnemies(room);
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
        updates.push({
          id: player.id,
          coins: player.coins,
          armorLevel: player.armorLevel,
          attackLevel: player.attackLevel
        });
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

    // Armor Pad (Left)
    const dxArmor = player.x - room.armorPad.x;
    const dyArmor = player.y - room.armorPad.y;
    if (dxArmor * dxArmor + dyArmor * dyArmor <= room.armorPad.radius * room.armorPad.radius) {
      if (player.coins >= UPGRADE_COST && player.armorLevel < MAX_STAT_LEVEL) {
        player.coins -= UPGRADE_COST;
        player.armorLevel += 1;
        updates.push({
          id: player.id,
          coins: player.coins,
          armorLevel: player.armorLevel,
          attackLevel: player.attackLevel
        });
      }
    }

    // Attack Pad (Right)
    const dxAttack = player.x - room.attackPad.x;
    const dyAttack = player.y - room.attackPad.y;
    if (dxAttack * dxAttack + dyAttack * dyAttack <= room.attackPad.radius * room.attackPad.radius) {
      if (player.coins >= UPGRADE_COST && player.attackLevel < MAX_STAT_LEVEL) {
        player.coins -= UPGRADE_COST;
        player.attackLevel += 1;
        updates.push({
          id: player.id,
          coins: player.coins,
          armorLevel: player.armorLevel,
          attackLevel: player.attackLevel
        });
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
  room.baseHp = BASE.maxHp;
  room.baseMaxHp = BASE.maxHp;

  const spawns = levelConfig.playerSpawns && levelConfig.playerSpawns.length
    ? levelConfig.playerSpawns
    : [{ x: ARENA.width / 2, y: ARENA.height / 2 }];

  let index = 0;
  room.players.forEach((p) => {
    const spawn = spawns[index % spawns.length];
    p.x = spawn.x;
    p.y = spawn.y;
    index++;

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

    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      socket.emit('errorMessage', { message: 'Room is full (no free spawn slots)' });
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
    if (!room || room.hostId !== socket.id) return;
    if (room.running) return;
    startRoomLoops(room);
  });

  socket.on('requestRestartGame', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id) return;
    restartGame(room);
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
    if (!proj) return;
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
