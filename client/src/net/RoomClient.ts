import { Client, Room } from 'colyseus.js';
import { PROTOCOL, PlayerInput, CrowdSnapshot, WorldSnapshot } from '@sleepy/shared';

export class RoomClient {
  private client: Client;
  private room: Room | null = null;
  private sessionId: string | null = null;

  constructor(private endpoint: string) {
    this.client = new Client(endpoint);
  }

  async connect(options?: { gameId?: string; sceneName?: string }) {
    this.room = await this.client.joinOrCreate('riot_room', options);
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
  }

  onCrowd(handler: (snapshot: CrowdSnapshot) => void) {
    if (!this.room) return;
    this.room.onMessage(PROTOCOL.crowd, (snapshot: CrowdSnapshot) => handler(snapshot));
  }

  getSessionId() {
    return this.sessionId;
  }

  async disconnect() {
    if (!this.room) return;
    await this.room.leave();
    this.room = null;
    this.sessionId = null;
  }
}
