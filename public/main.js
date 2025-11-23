const TEXTURES = {
  local: 'player-red',
  remote: 'player-blue',
  enemy: 'enemy-green',
};

console.log('main.js loaded');

const createCircleTexture = (scene, key, color) => {
  if (scene.textures.exists(key)) return;
  const size = 32;
  const graphics = scene.make.graphics({ x: 0, y: 0, add: false });
  graphics.fillStyle(color, 1);
  graphics.fillCircle(size / 2, size / 2, size / 2);
  graphics.generateTexture(key, size, size);
  graphics.destroy();
};

class PlayerSprite extends Phaser.Physics.Arcade.Sprite {
  constructor(scene, x, y, textureKey) {
    super(scene, x, y, textureKey);
  }

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
    this.socket = null;
    this.localPlayer = null;
    this.keys = null;
    this.speed = 200;
    this.lastSentPosition = null;
  }

  create() {
    console.log('ArenaScene.create()');
    createCircleTexture(this, TEXTURES.local, 0xff4d4d);
    createCircleTexture(this, TEXTURES.remote, 0x3b82f6);
    createCircleTexture(this, TEXTURES.enemy, 0x22c55e);

    // Input bindings for top-down movement
    this.keys = this.input.keyboard.addKeys({
      W: Phaser.Input.Keyboard.KeyCodes.W,
      A: Phaser.Input.Keyboard.KeyCodes.A,
      S: Phaser.Input.Keyboard.KeyCodes.S,
      D: Phaser.Input.Keyboard.KeyCodes.D,
    });

    this.setupSocket();
  }

  setupSocket() {
    this.socket = io();

    this.socket.on('connect', () => {
      console.log(`Connected to server as ${this.socket.id}`);
    });

    this.socket.on('currentPlayers', (players) => {
      players.forEach((player) => {
        const isLocal = player.id === this.socket.id;
        this.addPlayer(player, isLocal);
      });
    });

    this.socket.on('newPlayer', (player) => {
      this.addPlayer(player, false);
    });

    this.socket.on('playerMoved', (player) => {
      this.updateRemotePlayer(player);
    });

    this.socket.on('playerDisconnected', ({ id }) => {
      const sprite = this.players.get(id);
      if (!sprite) return;
      sprite.destroy();
      this.players.delete(id);
    });

    this.socket.on('currentEnemies', (enemies) => {
      enemies.forEach((enemy) => this.upsertEnemy(enemy));
    });

    this.socket.on('enemiesUpdated', (enemies) => {
      enemies.forEach((enemy) => this.upsertEnemy(enemy));
    });
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
      this.lastSentPosition = { x: sprite.x, y: sprite.y };
    }
  }

  updateRemotePlayer(player) {
    const sprite = this.players.get(player.id);
    if (!sprite) {
      this.addPlayer(player, false);
      return;
    }
    sprite.setPosition(player.x, player.y);
  }

  upsertEnemy(enemy) {
    let sprite = this.enemies.get(enemy.id);
    if (!sprite) {
      sprite = new PlayerSprite(this, enemy.x, enemy.y, TEXTURES.enemy);
      this.add.existing(sprite);
      this.physics.add.existing(sprite);
      sprite.init(false);
      sprite.setData('id', enemy.id);
      this.enemies.set(enemy.id, sprite);
    } else {
      sprite.setPosition(enemy.x, enemy.y);
    }
  }

  update() {
    if (!this.localPlayer || !this.socket || !this.socket.connected) return;
    const direction = new Phaser.Math.Vector2(0, 0);
    if (this.keys.W.isDown) direction.y -= 1;
    if (this.keys.S.isDown) direction.y += 1;
    if (this.keys.A.isDown) direction.x -= 1;
    if (this.keys.D.isDown) direction.x += 1;

    direction.normalize();
    this.localPlayer.setVelocity(direction.x * this.speed, direction.y * this.speed);

    const { x, y } = this.localPlayer;
    if (!this.lastSentPosition || Math.abs(x - this.lastSentPosition.x) > 0.5 || Math.abs(y - this.lastSentPosition.y) > 0.5) {
      this.socket.emit('playerMovement', { x, y });
      this.lastSentPosition = { x, y };
    }
  }
}

// Explicit render type avoids Phaser auto-detection issues in custom environments.
// Explicit render type avoids auto-detection issues; Phaser creates the canvas.
const config = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  backgroundColor: '#0f172a',
  scene: [ArenaScene],
  parent: 'game-container',
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { y: 0 },
      debug: false,
    },
  },
};

// Boot the game client
window.addEventListener('load', () => {
  new Phaser.Game(config);
});
