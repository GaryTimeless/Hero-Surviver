/* global Phaser, io */

const TEXTURES = {
  local: 'player-red',
  remote: 'player-blue',
  enemy: 'enemy-',
  projectile: 'projectile-white',
  coin: 'coin-yellow',
  upgradePad: 'upgrade-pad',
};

const GAME_COLORS = {
  bg: '#0f172a',
  enemy: ['#22c55e', '#38bdf8', '#f97316', '#c084fc', '#f59e0b'],
};

const UI = {};

const state = {
  socket: io(),
  roomId: null,
  isHost: false,
  playerName: '',
  game: null,
  scene: null,
  running: false,
  wave: 0,
  players: new Map(),
  enemies: new Map(),
  projectiles: new Map(),
  coins: new Map(),
  lastShotAt: 0,
  pendingPlayers: null,
};

const ARENA = { width: 800, height: 600 };
const FIRE_COOLDOWN_MS = 300;

const createCircleTexture = (scene, key, color, size = 32) => {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  g.fillStyle(color, 1);
  g.fillCircle(size / 2, size / 2, size / 2);
  g.generateTexture(key, size, size);
  g.destroy();
};

const createPolygonTexture = (scene, key, sides, color) => {
  if (scene.textures.exists(key)) return;
  const size = 36;
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  g.fillStyle(color, 1);
  const points = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = (Math.PI * 2 * i) / sides - Math.PI / 2;
    const x = size / 2 + (size / 2 - 2) * Math.cos(angle);
    const y = size / 2 + (size / 2 - 2) * Math.sin(angle);
    points.push({ x, y });
  }
  g.beginPath();
  g.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) g.lineTo(points[i].x, points[i].y);
  g.closePath();
  g.fillPath();
  g.generateTexture(key, size, size);
  g.destroy();
};

const getEnemyTextureKey = (scene, wave) => {
  const palette = GAME_COLORS.enemy[(wave - 1) % GAME_COLORS.enemy.length];
  const shapes = [0, 0, 4, 3, 5, 6]; // 0 = circle, otherwise polygon sides
  const shape = shapes[wave] ?? 0;
  const key = `${TEXTURES.enemy}${wave}`;
  if (shape === 0) {
    createCircleTexture(scene, key, Phaser.Display.Color.HexStringToColor(palette).color, 32);
  } else {
    createPolygonTexture(scene, key, shape, Phaser.Display.Color.HexStringToColor(palette).color);
  }
  return key;
};

class PlayerSprite extends Phaser.Physics.Arcade.Sprite {
  init(isLocal) {
    this.setOrigin(0.5);
    this.setCollideWorldBounds(true);
    if (!isLocal) this.setImmovable(true);
  }
}

class ArenaScene extends Phaser.Scene {
  constructor() {
    super({ key: 'ArenaScene' });
    this.players = new Map();
    this.enemies = new Map();
    this.projectiles = new Map();
    this.coins = new Map();
    this.localPlayer = null;
    this.localState = null;
    this.keys = null;
    this.speed = 200;
    this.lastSentPosition = null;
    this.hpText = null;
    this.waveText = null;
    this.coinText = null;
    this.weaponText = null;
    this.deathText = null;
    this.shopText = null;
    this.upgradePad = null;
  }

  preload() { }

  create() {
    state.scene = this;
    createCircleTexture(this, TEXTURES.local, 0xff4d4d);
    createCircleTexture(this, TEXTURES.remote, 0x3b82f6);
    createCircleTexture(this, TEXTURES.projectile, 0xf8fafc, 12);
    createCircleTexture(this, TEXTURES.coin, 0xf59e0b, 14);
    createCircleTexture(this, TEXTURES.upgradePad, 0x22c55e, 80);

    this.keys = this.input.keyboard.addKeys({
      W: Phaser.Input.Keyboard.KeyCodes.W,
      A: Phaser.Input.Keyboard.KeyCodes.A,
      S: Phaser.Input.Keyboard.KeyCodes.S,
      D: Phaser.Input.Keyboard.KeyCodes.D,
      SPACE: Phaser.Input.Keyboard.KeyCodes.SPACE,
    });

    this.createHud();
    this.drawUpgradePad();
    this.drawGate();
    this.resetWorld();
    if (Array.isArray(state.pendingPlayers)) {
      state.pendingPlayers.forEach((p) => this.addPlayer(p, p.id === state.socket.id));
      state.pendingPlayers = null;
    }
  }

  resetWorld() {
    this.players.forEach((p) => p.destroy());
    this.enemies.forEach((e) => e.destroy());
    this.projectiles.forEach((p) => p.destroy());
    this.coins.forEach((c) => c.destroy());
    this.players.clear();
    this.enemies.clear();
    this.projectiles.clear();
    this.coins.clear();
    this.localPlayer = null;
    this.localState = null;
    this.lastSentPosition = null;
    if (this.deathText) this.deathText.setVisible(false);
  }

  drawUpgradePad() {
    if (this.upgradePadSprite) this.upgradePadSprite.destroy();
    const pad = this.add.image(ARENA.width / 2, ARENA.height / 2, TEXTURES.upgradePad);
    pad.setAlpha(0.15);
    this.upgradePadSprite = pad;
  }

  drawGate() {
    const w = this.scale.width;
    const gateX = w / 2;
    const gateY = 10;

    const g = this.add.graphics();
    g.lineStyle(4, 0xff0000, 1);
    // left bar
    g.moveTo(gateX - 20, gateY);
    g.lineTo(gateX - 20, gateY + 40);
    // right bar
    g.moveTo(gateX + 20, gateY);
    g.lineTo(gateX + 20, gateY + 40);
    g.strokePath();
  }

  createHud() {
    this.hpText = this.add.text(16, 16, 'HP: --/--', { fontFamily: 'Arial', fontSize: '16px', color: '#ffffff' });
    this.coinText = this.add.text(16, 36, 'Coins: 0', { fontFamily: 'Arial', fontSize: '16px', color: '#fbbf24' });
    this.weaponText = this.add.text(16, 56, 'Weapon: Lv1', { fontFamily: 'Arial', fontSize: '16px', color: '#a5b4fc' });
    this.waveText = this.add.text(this.scale.width - 16, 16, 'Wave: 0', {
      fontFamily: 'Arial',
      fontSize: '16px',
      color: '#ffffff',
    }).setOrigin(1, 0);
    this.deathText = this.add.text(this.scale.width / 2, this.scale.height / 2, 'You died', {
      fontFamily: 'Arial',
      fontSize: '32px',
      color: '#ff4d4d',
    }).setOrigin(0.5).setVisible(false);

    this.shopText = this.add.text(this.scale.width / 2, 40, '', {
      fontFamily: 'Arial',
      fontSize: '18px',
      color: '#fbbf24',
    }).setOrigin(0.5, 0).setVisible(false);
  }

  addPlayer(playerData, isLocal) {
    if (this.players.has(playerData.id)) return;
    const textureKey = isLocal ? TEXTURES.local : TEXTURES.remote;
    const sprite = new PlayerSprite(this, playerData.x, playerData.y, textureKey);
    this.add.existing(sprite);
    this.physics.add.existing(sprite);
    sprite.init(isLocal);
    sprite.setData('id', playerData.id);
    this.players.set(playerData.id, sprite);
    if (isLocal) {
      this.localPlayer = sprite;
      this.localState = {
        hp: playerData.hp,
        maxHp: playerData.maxHp,
        isDead: playerData.isDead,
        coins: playerData.coins ?? 0,
        weaponLevel: playerData.weaponLevel ?? 1,
      };
      this.lastSentPosition = { x: sprite.x, y: sprite.y };
      this.updateHud();
      if (playerData.isDead) this.handleLocalDeath();
    }
  }

  updatePlayer(playerData) {
    const sprite = this.players.get(playerData.id);
    if (!sprite) return;
    sprite.setPosition(playerData.x, playerData.y);
  }

  removePlayer(id) {
    const sprite = this.players.get(id);
    if (sprite) sprite.destroy();
    this.players.delete(id);
  }

  upsertEnemy(enemy) {
    let sprite = this.enemies.get(enemy.id);
    const textureKey = getEnemyTextureKey(this, enemy.wave || 1);
    if (!sprite) {
      sprite = this.add.image(enemy.x, enemy.y, textureKey);
      this.enemies.set(enemy.id, sprite);
    } else {
      sprite.setTexture(textureKey);
      sprite.setPosition(enemy.x, enemy.y);
    }
  }

  upsertProjectile(proj) {
    let sprite = this.projectiles.get(proj.id);
    if (!sprite) {
      sprite = this.add.image(proj.x, proj.y, TEXTURES.projectile).setScale(0.5);
      this.projectiles.set(proj.id, sprite);
    } else {
      sprite.setPosition(proj.x, proj.y);
    }
  }

  upsertCoin(coin) {
    let sprite = this.coins.get(coin.id);
    if (!sprite) {
      sprite = this.add.image(coin.x, coin.y, TEXTURES.coin).setScale(0.8);
      this.coins.set(coin.id, sprite);
    } else {
      sprite.setPosition(coin.x, coin.y);
    }
  }

  removeMissing(map, latestIds) {
    map.forEach((sprite, id) => {
      if (!latestIds.has(id)) {
        sprite.destroy();
        map.delete(id);
      }
    });
  }

  handleHpUpdates(updates) {
    updates.forEach((u) => {
      if (u.id === state.socket.id && this.localState) {
        this.localState.hp = u.hp;
        this.localState.maxHp = u.maxHp ?? this.localState.maxHp;
        this.updateHud();
      }
    });
  }

  handlePlayerDeath(id) {
    if (id === state.socket.id && this.localState) {
      this.localState.isDead = true;
      this.handleLocalDeath();
    }
  }

  handleLocalDeath() {
    if (this.deathText) this.deathText.setVisible(true);
    if (this.localPlayer) this.localPlayer.setVelocity(0, 0);
  }

  updateHud() {
    if (!this.localState) return;
    const { hp, maxHp, coins, weaponLevel } = this.localState;
    if (this.hpText) this.hpText.setText(`HP: ${hp}/${maxHp}`);
    if (this.coinText) this.coinText.setText(`Coins: ${coins ?? 0}`);
    if (this.weaponText) this.weaponText.setText(`Weapon: Lv${weaponLevel ?? 1}`);
    if (this.waveText) this.waveText.setText(`Wave: ${state.wave}`);
  }

  update() {
    if (!this.localPlayer || !state.running) return;
    if (this.localState?.isDead) {
      this.localPlayer.setVelocity(0, 0);
      return;
    }
    const direction = new Phaser.Math.Vector2(0, 0);
    if (this.keys.W.isDown) direction.y -= 1;
    if (this.keys.S.isDown) direction.y += 1;
    if (this.keys.A.isDown) direction.x -= 1;
    if (this.keys.D.isDown) direction.x += 1;

    direction.normalize();
    this.localPlayer.setVelocity(direction.x * this.speed, direction.y * this.speed);

    const pointer = this.input.activePointer;
    if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE) && pointer) {
      this.tryShoot(pointer.worldX, pointer.worldY);
    }

    const { x, y } = this.localPlayer;
    if (!this.lastSentPosition || Math.abs(x - this.lastSentPosition.x) > 0.5 || Math.abs(y - this.lastSentPosition.y) > 0.5) {
      state.socket.emit('playerMovement', { x, y });
      this.lastSentPosition = { x, y };
    }
  }

  tryShoot(targetX, targetY) {
    const now = performance.now();
    if (now - state.lastShotAt < FIRE_COOLDOWN_MS) return;
    if (!this.localPlayer) return;
    const dir = { x: targetX - this.localPlayer.x, y: targetY - this.localPlayer.y };
    state.socket.emit('playerShoot', dir);
    state.lastShotAt = now;
  }

  showShopMessage(durationMs) {
    if (!this.shopText) return;
    this.shopText.setText('Wave cleared! Spend your coins on the green pad.');
    this.shopText.setVisible(true);
    this.time.delayedCall(durationMs || 5000, () => {
      if (this.shopText) this.shopText.setVisible(false);
    });
  }
}

// --- UI helpers ---
const qs = (id) => document.getElementById(id);

const showPanel = (panel) => {
  ['menu-panel', 'lobby-panel'].forEach((id) => {
    const el = qs(id);
    if (!el) return;
    el.classList.toggle('visible', id === panel);
  });
};

const updateLobbyUI = (roomState) => {
  if (!roomState) return;
  qs('room-label').textContent = roomState.roomId || '----';
  const list = qs('players-list');
  list.innerHTML = '';
  roomState.players.forEach((p) => {
    const li = document.createElement('li');
    const readyText = p.isReady ? '✅' : '⏳';
    const hostText = p.isHost ? ' (host)' : '';
    li.textContent = `${readyText} ${p.name}${hostText}`;
    list.appendChild(li);
  });
  const readyBtn = qs('ready-btn');
  const startBtn = qs('start-btn');
  if (readyBtn) readyBtn.textContent = state?.localReady ? 'Unready' : 'Ready';
  if (startBtn) startBtn.disabled = !(state.isHost && roomState.players.some((p) => p.isReady));
};

// --- Socket events ---
const wireSocket = () => {
  const { socket } = state;

  socket.on('connect', () => {
    state.socketId = socket.id;
  });

  socket.on('roomJoined', ({ roomId }) => {
    state.roomId = roomId;
    showPanel('lobby-panel');
  });

  socket.on('roomState', (roomState) => {
    state.isHost = roomState.hostId === state.socket.id;
    state.running = roomState.running;
    state.wave = roomState.wave || 0;
    state.players.clear();
    roomState.players.forEach((p) => state.players.set(p.id, p));
    state.localReady = roomState.players.find((p) => p.id === state.socket.id)?.isReady || false;
    updateLobbyUI(roomState);
    if (!roomState.running && state.game) {
      // Back to lobby view
      if (state.scene) {
        state.scene.resetWorld();
      }
      state.running = false;
    }
  });

  socket.on('currentPlayers', (players) => {
    if (!state.scene) {
      state.pendingPlayers = players;
      return;
    }
    state.scene.resetWorld();
    players.forEach((p) => {
      const isLocal = p.id === state.socket.id;
      state.scene.addPlayer(p, isLocal);
      state.players.set(p.id, p);
    });
  });

  socket.on('playerMoved', (player) => {
    if (!state.scene) return;
    state.scene.updatePlayer(player);
  });

  socket.on('playerHpUpdated', (updates) => {
    if (!state.scene) return;
    state.scene.handleHpUpdates(updates);
  });

  socket.on('playerDied', ({ id }) => {
    if (!state.scene) return;
    state.scene.handlePlayerDeath(id);
  });

  socket.on('waveUpdated', ({ wave }) => {
    state.wave = wave || 0;
    if (state.scene) state.scene.updateHud();
  });

  socket.on('waveCleared', ({ wave, nextWaveInMs }) => {
    state.wave = wave || state.wave;
    if (state.scene) {
      state.scene.updateHud();
      state.scene.showShopMessage(nextWaveInMs || 5000);
    }
  });

  socket.on('enemiesUpdated', (enemies) => {
    if (!state.scene) return;
    const ids = new Set();
    enemies.forEach((e) => {
      ids.add(e.id);
      state.scene.upsertEnemy(e);
    });
    state.scene.removeMissing(state.scene.enemies, ids);
  });

  socket.on('projectilesUpdated', (projectiles) => {
    if (!state.scene) return;
    const ids = new Set();
    projectiles.forEach((p) => {
      ids.add(p.id);
      state.scene.upsertProjectile(p);
    });
    state.scene.removeMissing(state.scene.projectiles, ids);
  });

  socket.on('coinsUpdated', (coins) => {
    if (!state.scene) return;
    const ids = new Set();
    coins.forEach((c) => {
      ids.add(c.id);
      state.scene.upsertCoin(c);
    });
    state.scene.removeMissing(state.scene.coins, ids);
  });

  socket.on('playerStatsUpdated', (updates) => {
    updates.forEach((u) => {
      const player = state.players.get(u.id);
      if (player) {
        player.coins = u.coins;
        player.weaponLevel = u.weaponLevel;
      }
      if (u.id === state.socket.id && state.scene?.localState) {
        state.scene.localState.coins = u.coins;
        state.scene.localState.weaponLevel = u.weaponLevel;
        state.scene.updateHud();
      }
    });
  });

  socket.on('gameStarted', () => {
    state.running = true;
    startGame();
  });

  socket.on('gameOver', ({ wave, reason }) => {
    state.running = false;
    state.wave = wave || state.wave;
    const status = qs('lobby-status');
    if (status) status.textContent = `Game over (${reason || 'ended'}) on wave ${state.wave}.`;
    showPanel('lobby-panel');
  });

  socket.on('errorMessage', ({ message }) => {
    const el = qs('menu-status') || qs('lobby-status');
    if (el) el.textContent = message;
    console.warn(message);
  });
};

// --- Game boot ---
const startGame = () => {
  showPanel(null);
  if (!state.game) {
    const config = {
      type: Phaser.AUTO,
      width: ARENA.width,
      height: ARENA.height,
      backgroundColor: GAME_COLORS.bg,
      scene: [ArenaScene],
      parent: 'game-container',
      physics: {
        default: 'arcade',
        arcade: { gravity: { y: 0 }, debug: false },
      },
    };
    state.game = new Phaser.Game(config);
  } else if (state.scene) {
    state.scene.resetWorld();
  }
};

// --- UI wiring ---
const wireUi = () => {
  UI.menuStatus = qs('menu-status');
  UI.lobbyStatus = qs('lobby-status');
  const nameInput = qs('player-name');
  const roomInput = qs('room-code-input');
  const createBtn = qs('create-room-btn');
  const joinBtn = qs('join-room-btn');
  const readyBtn = qs('ready-btn');
  const startBtn = qs('start-btn');

  const getName = () => (nameInput?.value?.trim() ? nameInput.value.trim() : 'Hero');

  createBtn?.addEventListener('click', () => {
    state.playerName = getName();
    state.socket.emit('createRoom', { name: state.playerName });
    showPanel('lobby-panel');
  });

  joinBtn?.addEventListener('click', () => {
    const roomId = roomInput?.value?.trim().toUpperCase();
    if (!roomId) {
      if (UI.menuStatus) UI.menuStatus.textContent = 'Enter a room code.';
      return;
    }
    state.playerName = getName();
    state.socket.emit('joinRoom', { roomId, name: state.playerName });
  });

  readyBtn?.addEventListener('click', () => {
    state.localReady = !state.localReady;
    state.socket.emit('playerReady', { ready: state.localReady });
    if (readyBtn) readyBtn.textContent = state.localReady ? 'Unready' : 'Ready';
  });

  startBtn?.addEventListener('click', () => {
    state.socket.emit('startGame');
  });
};

// --- Init ---
window.addEventListener('load', () => {
  wireUi();
  wireSocket();
  console.log('main.js loaded');
});
