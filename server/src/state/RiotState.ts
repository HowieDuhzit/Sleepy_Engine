import { MapSchema, Schema, type } from '@colyseus/schema';

export class PlayerState extends Schema {
  @type('string') id = '';
  @type('number') x = 0;
  @type('number') y = 0;
  @type('number') z = 0;
  @type('number') vx = 0;
  @type('number') vy = 0;
  @type('number') vz = 0;
  @type('number') health = 100;
  @type('number') stamina = 100;
  @type('number') lookYaw = 0;
  @type('number') lookPitch = 0;
  @type('string') animState = 'idle';
  @type('number') animTime = 0;
  @type('number') yaw = 0;
}

export class RiotState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type('number') heat = 0.1;
  @type('number') phase = 0;
}
