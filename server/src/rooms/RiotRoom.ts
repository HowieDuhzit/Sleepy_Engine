import colyseusPkg from 'colyseus';
import { RiotState, PlayerState } from '../state/RiotState.js';
import {
  PROTOCOL,
  PlayerInput,
  MOVE_SPEED,
  SPRINT_MULTIPLIER,
  CROUCH_MULTIPLIER,
  SLIDE_ACCEL,
  SLIDE_FRICTION,
  PLAYER_RADIUS,
  GRAVITY,
  JUMP_SPEED,
  GROUND_Y,
  OBSTACLES,
  resolveCircleAabb,
} from '@trashy/shared';

const { Room } = colyseusPkg as typeof import('colyseus');
type Client = import('colyseus').Client;

export class RiotRoom extends Room {
  declare state: RiotState;
  private inputBuffer = new Map<string, PlayerInput>();

  onCreate() {
    this.setState(new RiotState());
    this.setSimulationInterval((dt) => this.update(dt), 1000 / 20);

    this.onMessage(PROTOCOL.input, (client, message: PlayerInput) => {
      this.inputBuffer.set(client.sessionId, message);
    });
  }

  onJoin(client: Client) {
    const player = new PlayerState();
    player.id = client.sessionId;
    player.x = (Math.random() - 0.5) * 10;
    player.z = (Math.random() - 0.5) * 10;
    player.y = GROUND_Y;
    player.vy = 0;
    this.state.players.set(client.sessionId, player);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.inputBuffer.delete(client.sessionId);
  }

  private update(dt: number) {
    const delta = dt / 1000;
    for (const [id, player] of this.state.players.entries()) {
      const input = this.inputBuffer.get(id);
      if (!input) continue;

      const speed =
        MOVE_SPEED * (input.sprint ? SPRINT_MULTIPLIER : input.crouch ? CROUCH_MULTIPLIER : 1);
      const slideMode = input.sprint || input.crouch;
      const accel = Math.min(1, SLIDE_ACCEL * delta);
      const targetVx = input.moveX * speed;
      const targetVz = input.moveZ * speed;
      if (slideMode) {
        player.vx += (targetVx - player.vx) * accel;
        player.vz += (targetVz - player.vz) * accel;
        if (Math.abs(input.moveX) < 0.05 && Math.abs(input.moveZ) < 0.05) {
          const damping = Math.max(0, 1 - SLIDE_FRICTION * delta);
          player.vx *= damping;
          player.vz *= damping;
        }
      } else {
        player.vx = targetVx;
        player.vz = targetVz;
      }

      if (input.jump && player.y <= GROUND_Y + 0.001) {
        player.vy = JUMP_SPEED;
      }
      player.vy += GRAVITY * delta;
      player.y += player.vy * delta;
      if (player.y <= GROUND_Y) {
        player.y = GROUND_Y;
        player.vy = 0;
      }

      player.x += player.vx * delta;
      player.z += player.vz * delta;

      let resolved = { x: player.x, y: player.y, z: player.z };
      for (const obstacle of OBSTACLES) {
        resolved = resolveCircleAabb(resolved, PLAYER_RADIUS, obstacle);
      }
      player.x = resolved.x;
      player.z = resolved.z;

      player.stamina = Math.max(0, Math.min(100, player.stamina - (input.sprint ? 8 : 2) * delta));
    }

    this.state.heat = Math.min(1, this.state.heat + 0.0005);
    this.state.phase = this.state.heat > 0.7 ? 2 : this.state.heat > 0.4 ? 1 : 0;
  }
}
