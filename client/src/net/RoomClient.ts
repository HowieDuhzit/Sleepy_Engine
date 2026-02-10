import { Client, Room } from 'colyseus.js';
import { PlayerSnapshot, PROTOCOL, PlayerInput, CrowdSnapshot, WorldSnapshot } from '@sleepy/shared';

export class RoomClient {
  private client: Client;
  private room: Room | null = null;
  private sessionId: string | null = null;

  constructor(private endpoint: string) {
    this.client = new Client(endpoint);
  }

  async connect() {
    this.room = await this.client.joinOrCreate('riot_room');
    this.sessionId = this.room.sessionId;
  }

  sendInput(input: PlayerInput) {
    if (!this.room) return;
    this.room.send(PROTOCOL.input, input);
  }

  onSnapshot(handler: (state: WorldSnapshot) => void) {
    if (!this.room) return;
    this.room.onMessage(PROTOCOL.snapshot, (state: WorldSnapshot) => {
      handler(state);
    });
    this.room.onStateChange.once((state) => {
      handler(this.serializeState(state));
    });
    this.room.onStateChange((state) => handler(this.serializeState(state)));
  }

  onCrowd(handler: (snapshot: CrowdSnapshot) => void) {
    if (!this.room) return;
    this.room.onMessage(PROTOCOL.crowd, (snapshot: CrowdSnapshot) => handler(snapshot));
  }

  private serializeState(state: any): WorldSnapshot {
    const players: Record<string, PlayerSnapshot> = {};
    if (!state?.players) {
      return { players, heat: 0, phase: 0 };
    }
    for (const [id, player] of state.players.entries()) {
      players[id] = {
        id,
        position: { x: player.x, y: player.y, z: player.z },
        velocity: { x: player.vx, y: player.vy, z: player.vz },
        health: player.health,
        stamina: player.stamina,
        lookYaw: player.lookYaw ?? 0,
        lookPitch: player.lookPitch ?? 0,
        animState: player.animState ?? 'idle',
        animTime: player.animTime ?? 0,
        yaw: player.yaw ?? 0,
      };
    }
    return {
      players,
      heat: state?.heat ?? 0,
      phase: state?.phase ?? 0,
    };
  }

  getSessionId() {
    return this.sessionId;
  }
}
