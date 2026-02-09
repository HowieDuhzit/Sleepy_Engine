import { Client, Room } from 'colyseus.js';
import { PlayerSnapshot, PROTOCOL, PlayerInput } from '@trashy/shared';

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

  onSnapshot(handler: (state: Record<string, PlayerSnapshot>) => void) {
    if (!this.room) return;
    this.room.onStateChange((state) => {
      const players: Record<string, PlayerSnapshot> = {};
      for (const [id, player] of state.players.entries()) {
        players[id] = {
          id,
          position: { x: player.x, y: player.y, z: player.z },
          velocity: { x: player.vx, y: player.vy, z: player.vz },
          health: player.health,
          stamina: player.stamina,
        };
      }
      handler(players);
    });
  }

  getSessionId() {
    return this.sessionId;
  }
}
