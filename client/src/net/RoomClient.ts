import { Client, Room } from 'colyseus.js';
import {
  PROTOCOL,
  PlayerInput,
  CrowdSnapshot,
  WorldSnapshot,
  ObstacleDynamicsSnapshot,
} from '@sleepy/shared';

export class RoomClient {
  private client: Client;
  private room: Room | null = null;
  private sessionId: string | null = null;
  private lifecycleToken = 0;

  constructor(private endpoint: string) {
    this.client = new Client(endpoint);
  }

  async connect(options?: { gameId?: string; sceneName?: string }) {
    const token = ++this.lifecycleToken;
    const room = await this.client.joinOrCreate('engine_room', options);
    if (token !== this.lifecycleToken) {
      await room.leave();
      return;
    }
    this.room = room;
    this.sessionId = room.sessionId;
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

  onObstacleDynamics(handler: (snapshot: ObstacleDynamicsSnapshot) => void) {
    if (!this.room) return;
    this.room.onMessage(PROTOCOL.obstacleDynamics, (snapshot: ObstacleDynamicsSnapshot) =>
      handler(snapshot),
    );
  }

  getSessionId() {
    return this.sessionId;
  }

  async disconnect() {
    this.lifecycleToken += 1;
    if (!this.room) {
      this.sessionId = null;
      return;
    }
    const room = this.room;
    this.room = null;
    this.sessionId = null;
    await room.leave();
  }
}
