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
  CROWD_COUNT,
  CROWD_RADIUS,
  CROWD_SPEED,
  CROWD_ATTACK_RANGE,
  CROWD_ATTACK_COOLDOWN,
  CROWD_ATTACK_DAMAGE,
  CROWD_FLEE_TIME,
  CROWD_FIGHT_TIME,
  CROWD_HIT_KNOCKBACK,
  CROWD_REPEL_RADIUS,
  CROWD_REPEL_FORCE,
  CROWD_BOUNDS,
  GRAVITY,
  JUMP_SPEED,
  GROUND_Y,
  STEP_HEIGHT,
  ATTACK_RANGE,
  ATTACK_COOLDOWN,
  ATTACK_DAMAGE,
  ATTACK_KNOCKBACK,
  OBSTACLES,
  resolveCircleAabb,
  resolveCircleCircle,
} from '@sleepy/shared';

const { Room } = colyseusPkg as typeof import('colyseus');
type Client = import('colyseus').Client;

type NavCell = { i: number; j: number };

class NavGrid {
  private half: number;
  private cell: number;
  private cols: number;
  private rows: number;
  private blocked = new Set<string>();

  constructor(half: number, cell: number, obstacles: typeof OBSTACLES) {
    this.half = half;
    this.cell = cell;
    this.cols = Math.floor((half * 2) / cell);
    this.rows = Math.floor((half * 2) / cell);
    for (let i = 0; i < this.cols; i += 1) {
      for (let j = 0; j < this.rows; j += 1) {
        const pos = this.cellToWorld(i, j);
        if (this.isBlocked(pos.x, pos.z, obstacles)) {
          this.blocked.add(this.key(i, j));
        }
      }
    }
  }

  private key(i: number, j: number) {
    return `${i},${j}`;
  }

  private isBlocked(x: number, z: number, obstacles: typeof OBSTACLES) {
    for (const obstacle of obstacles) {
      const halfX = obstacle.size.x / 2 + CROWD_RADIUS;
      const halfZ = obstacle.size.z / 2 + CROWD_RADIUS;
      if (Math.abs(x - obstacle.position.x) <= halfX && Math.abs(z - obstacle.position.z) <= halfZ) {
        return true;
      }
    }
    return false;
  }

  worldToCell(x: number, z: number) {
    const i = Math.floor((x + this.half) / this.cell);
    const j = Math.floor((z + this.half) / this.cell);
    return { i, j };
  }

  cellToWorld(i: number, j: number) {
    return {
      x: -this.half + i * this.cell + this.cell / 2,
      z: -this.half + j * this.cell + this.cell / 2,
    };
  }

  randomOpen() {
    for (let tries = 0; tries < 20; tries += 1) {
      const i = Math.floor(Math.random() * this.cols);
      const j = Math.floor(Math.random() * this.rows);
      if (!this.blocked.has(this.key(i, j))) {
        return this.cellToWorld(i, j);
      }
    }
    return null;
  }

  findPath(sx: number, sz: number, gx: number, gz: number) {
    const start = this.worldToCell(sx, sz);
    const goal = this.worldToCell(gx, gz);
    const startKey = this.key(start.i, start.j);
    const goalKey = this.key(goal.i, goal.j);
    if (this.blocked.has(goalKey)) return null;

    const open: NavCell[] = [start];
    const came = new Map<string, string>();
    const gScore = new Map<string, number>();
    gScore.set(startKey, 0);

    const h = (a: NavCell, b: NavCell) => Math.abs(a.i - b.i) + Math.abs(a.j - b.j);

    while (open.length > 0) {
      const score = (n: NavCell) => (gScore.get(this.key(n.i, n.j)) ?? Infinity) + h(n, goal);
      open.sort((a, b) => score(a) - score(b));
      const current = open.shift()!;
      const currentKey = this.key(current.i, current.j);
      if (currentKey === goalKey) {
        const path: Array<{ x: number; z: number }> = [];
        let k: string | undefined = currentKey;
        while (k) {
          const parts = k.split(',');
          const ci = Number(parts[0] ?? 0);
          const cj = Number(parts[1] ?? 0);
          path.push(this.cellToWorld(ci, cj));
          k = came.get(k);
        }
        return path.reverse();
      }

      const neighbors = [
        { i: current.i + 1, j: current.j },
        { i: current.i - 1, j: current.j },
        { i: current.i, j: current.j + 1 },
        { i: current.i, j: current.j - 1 },
      ];
      for (const n of neighbors) {
        if (n.i < 0 || n.j < 0 || n.i >= this.cols || n.j >= this.rows) continue;
        const nKey = this.key(n.i, n.j);
        if (this.blocked.has(nKey)) continue;
        const tentative = (gScore.get(currentKey) ?? 0) + 1;
        if (tentative < (gScore.get(nKey) ?? Infinity)) {
          came.set(nKey, currentKey);
          gScore.set(nKey, tentative);
          if (!open.find((o) => o.i === n.i && o.j === n.j)) {
            open.push(n);
          }
        }
      }
    }
    return null;
  }
}

export class RiotRoom extends Room {
  declare state: RiotState;
  private inputBuffer = new Map<string, PlayerInput>();
  private lastAttackAt = new Map<string, number>();
  private elapsed = 0;
  private crowdUpdateCounter = 0; // For reducing crowd update rate
  private readonly navCell = 2.5;
  private readonly navHalf = CROWD_BOUNDS;
  private navGrid!: NavGrid;
  private readonly CROWD_NEAR_RADIUS = 50; // Only send crowd within 50m of players
  private crowd = Array.from({ length: CROWD_COUNT }, (_, id) => ({
    id,
    x: (Math.random() - 0.5) * 30,
    y: GROUND_Y,
    z: (Math.random() - 0.5) * 30,
    vx: 0,
    vy: 0,
    vz: 0,
    targetX: 0,
    targetZ: 0,
    path: [] as Array<{ x: number; z: number }>,
    pathIndex: 0,
    health: 30,
    state: 'idle' as 'idle' | 'walk' | 'run' | 'hit' | 'attack',
    stateTimer: 0,
    stateTime: 0,
    behavior: 'wander' as 'wander' | 'flee' | 'fight',
    behaviorTimer: 0,
    lastAttackAt: -Infinity,
    threatId: '' as string,
  }));

  private sampleGroundHeight(x: number, z: number) {
    let height = GROUND_Y;
    for (const obstacle of OBSTACLES) {
      const halfX = obstacle.size.x / 2;
      const halfZ = obstacle.size.z / 2;
      if (Math.abs(x - obstacle.position.x) <= halfX && Math.abs(z - obstacle.position.z) <= halfZ) {
        height = Math.max(height, obstacle.position.y + obstacle.size.y);
      }
    }
    return height;
  }

  onCreate() {
    this.setState(new RiotState());
    this.maxClients = 16;
    this.setPrivate(false);
    this.setSimulationInterval((dt) => this.update(dt), 1000 / 20);
    this.navGrid = new NavGrid(this.navHalf, this.navCell, OBSTACLES);

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
    this.elapsed += delta;
    let heatDelta = 0;
    for (const [id, player] of this.state.players.entries()) {
      const input = this.inputBuffer.get(id);
      if (!input) continue;

      player.lookYaw = input.lookYaw;
      player.lookPitch = input.lookPitch;
      player.animState = input.animState;
      player.animTime = input.animTime;

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

      if (Math.abs(player.vx) > 0.05 || Math.abs(player.vz) > 0.05) {
        player.yaw = Math.atan2(player.vx, player.vz) + Math.PI;
      }

      const groundHeight = this.sampleGroundHeight(player.x, player.z);
      if (input.jump && player.y <= groundHeight + 0.001) {
        player.vy = JUMP_SPEED;
      }
      player.vy += GRAVITY * delta;
      player.y += player.vy * delta;
      if (player.y <= groundHeight) {
        player.y = groundHeight;
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
      const floorY = this.sampleGroundHeight(player.x, player.z);
      if (player.y < floorY) {
        player.y = floorY;
        player.vy = 0;
      }

      player.stamina = Math.max(0, Math.min(100, player.stamina - (input.sprint ? 8 : 2) * delta));
    }

    const playersArray = Array.from(this.state.players.values());
    for (let i = 0; i < playersArray.length; i += 1) {
      for (let j = i + 1; j < playersArray.length; j += 1) {
        const a = playersArray[i]!;
        const b = playersArray[j]!;
        const posA = resolveCircleCircle({ x: a.x, y: a.y, z: a.z }, PLAYER_RADIUS, b, PLAYER_RADIUS);
        const posB = resolveCircleCircle({ x: b.x, y: b.y, z: b.z }, PLAYER_RADIUS, a, PLAYER_RADIUS);
        a.x = posA.x;
        a.z = posA.z;
        b.x = posB.x;
        b.z = posB.z;
      }
    }

    for (const agent of this.crowd) {
      if (agent.stateTimer > 0) {
        agent.stateTimer = Math.max(0, agent.stateTimer - delta);
        agent.stateTime += delta;
      } else {
        agent.stateTime = 0;
      }
      if (agent.behaviorTimer > 0) {
        agent.behaviorTimer = Math.max(0, agent.behaviorTimer - delta);
        if (agent.behaviorTimer === 0) {
          agent.behavior = 'wander';
        }
      }
      if (agent.path.length === 0 || agent.pathIndex >= agent.path.length) {
        const target = this.navGrid.randomOpen();
        if (target) {
          agent.targetX = target.x;
          agent.targetZ = target.z;
          const path = this.navGrid.findPath(agent.x, agent.z, agent.targetX, agent.targetZ);
          agent.path = path ?? [];
          agent.pathIndex = 0;
        }
      }
      if (agent.path.length > 0 && agent.pathIndex < agent.path.length) {
        const waypoint = agent.path[agent.pathIndex]!;
        const dx = waypoint.x - agent.x;
        const dz = waypoint.z - agent.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.6) {
          agent.pathIndex += 1;
        }
      }

      let ax = 0;
      let az = 0;
      let behaviorSpeed = CROWD_SPEED;
      for (const player of this.state.players.values()) {
        const dx = agent.x - player.x;
        const dz = agent.z - player.z;
        const distSq = dx * dx + dz * dz;
        if (distSq > CROWD_REPEL_RADIUS * CROWD_REPEL_RADIUS) continue;
        const dist = Math.max(0.001, Math.sqrt(distSq));
        const force = (CROWD_REPEL_FORCE * (CROWD_REPEL_RADIUS - dist)) / CROWD_REPEL_RADIUS;
        ax += (dx / dist) * force;
        az += (dz / dist) * force;
      }
      if (agent.behavior !== 'wander') {
        const players = Array.from(this.state.players.values());
        if (players.length > 0) {
          let target = players[0]!;
          let best = Infinity;
          for (const player of players) {
            const dx = player.x - agent.x;
            const dz = player.z - agent.z;
            const distSq = dx * dx + dz * dz;
            if (distSq < best) {
              best = distSq;
              target = player;
            }
          }
          const dx = target.x - agent.x;
          const dz = target.z - agent.z;
          const dist = Math.max(0.001, Math.hypot(dx, dz));
          if (agent.behavior === 'fight') {
            ax += (dx / dist) * 2.2;
            az += (dz / dist) * 2.2;
            behaviorSpeed = CROWD_SPEED * 1.6;
            if (dist <= CROWD_ATTACK_RANGE) {
              if (this.elapsed - agent.lastAttackAt >= CROWD_ATTACK_COOLDOWN) {
                agent.lastAttackAt = this.elapsed;
                agent.state = 'attack';
                agent.stateTimer = 0.25;
                agent.stateTime = 0;
                target.health = Math.max(0, target.health - CROWD_ATTACK_DAMAGE);
                target.vx += (dx / dist) * CROWD_HIT_KNOCKBACK;
                target.vz += (dz / dist) * CROWD_HIT_KNOCKBACK;
              }
            }
          } else if (agent.behavior === 'flee') {
            ax += (-dx / dist) * 2.4;
            az += (-dz / dist) * 2.4;
            behaviorSpeed = CROWD_SPEED * 1.9;
          }
        }
      } else if (agent.path.length > 0 && agent.pathIndex < agent.path.length) {
        const waypoint = agent.path[agent.pathIndex]!;
        const dx = waypoint.x - agent.x;
        const dz = waypoint.z - agent.z;
        const dist = Math.max(0.001, Math.hypot(dx, dz));
        ax += (dx / dist) * 1.6;
        az += (dz / dist) * 1.6;
      } else {
        const wander = 0.6;
        ax += Math.cos(this.elapsed * 0.6 + agent.id) * wander;
        az += Math.sin(this.elapsed * 0.5 + agent.id * 1.3) * wander;
      }

      agent.vx += ax * delta;
      agent.vz += az * delta;
      const speed = Math.hypot(agent.vx, agent.vz);
      if (speed > behaviorSpeed) {
        agent.vx = (agent.vx / speed) * behaviorSpeed;
        agent.vz = (agent.vz / speed) * behaviorSpeed;
      }
      agent.x += agent.vx * delta;
      agent.z += agent.vz * delta;
      agent.x = Math.max(-CROWD_BOUNDS, Math.min(CROWD_BOUNDS, agent.x));
      agent.z = Math.max(-CROWD_BOUNDS, Math.min(CROWD_BOUNDS, agent.z));

      let resolved = { x: agent.x, y: agent.y, z: agent.z };
      for (const obstacle of OBSTACLES) {
        resolved = resolveCircleAabb(resolved, CROWD_RADIUS, obstacle);
      }
      agent.x = resolved.x;
      agent.z = resolved.z;
      if (agent.stateTimer <= 0) {
        const moveSpeed = Math.hypot(agent.vx, agent.vz);
        if (agent.behavior === 'flee' || agent.behavior === 'fight') {
          agent.state = 'run';
        } else if (moveSpeed > 0.25) {
          agent.state = 'walk';
        } else {
          agent.state = 'idle';
        }
      }
    }

    for (const player of this.state.players.values()) {
      let pos = { x: player.x, y: player.y, z: player.z };
      for (const agent of this.crowd) {
        pos = resolveCircleCircle(pos, PLAYER_RADIUS, agent, CROWD_RADIUS);
      }
      player.x = pos.x;
      player.z = pos.z;
    }

    for (const [id, player] of this.state.players.entries()) {
      const input = this.inputBuffer.get(id);
      if (!input || !input.attack) continue;
      const last = this.lastAttackAt.get(id) ?? -Infinity;
      if (this.elapsed - last < ATTACK_COOLDOWN) continue;
      this.lastAttackAt.set(id, this.elapsed);
      heatDelta += 0.02;

      for (const [otherId, other] of this.state.players.entries()) {
        if (otherId === id) continue;
        const dx = other.x - player.x;
        const dz = other.z - player.z;
        const distSq = dx * dx + dz * dz;
        if (distSq > ATTACK_RANGE * ATTACK_RANGE) continue;
        const dist = Math.max(0.001, Math.sqrt(distSq));
        const nx = dx / dist;
        const nz = dz / dist;
        other.health = Math.max(0, other.health - ATTACK_DAMAGE);
        other.vx += nx * ATTACK_KNOCKBACK;
        other.vz += nz * ATTACK_KNOCKBACK;
      }

      for (const agent of this.crowd) {
        const dx = agent.x - player.x;
        const dz = agent.z - player.z;
        const distSq = dx * dx + dz * dz;
        if (distSq > ATTACK_RANGE * ATTACK_RANGE) continue;
        const dist = Math.max(0.001, Math.sqrt(distSq));
        const nx = dx / dist;
        const nz = dz / dist;
        agent.health = Math.max(0, agent.health - ATTACK_DAMAGE);
        agent.vx += nx * CROWD_HIT_KNOCKBACK;
        agent.vz += nz * CROWD_HIT_KNOCKBACK;
        agent.state = 'hit';
        agent.stateTimer = 0.3;
        agent.stateTime = 0;
        agent.threatId = id;
        const fightRoll = agent.health > 12 && Math.random() < 0.35;
        agent.behavior = fightRoll ? 'fight' : 'flee';
        agent.behaviorTimer = fightRoll ? CROWD_FIGHT_TIME : CROWD_FLEE_TIME;
      }
    }

    this.state.heat = Math.max(0, Math.min(1, this.state.heat + heatDelta - 0.01 * delta));
    this.state.phase = this.state.heat > 0.7 ? 2 : this.state.heat > 0.4 ? 1 : 0;

    const snapshot: Record<
      string,
      {
        id: string;
        position: { x: number; y: number; z: number };
        velocity: { x: number; y: number; z: number };
        health: number;
        stamina: number;
        lookYaw: number;
        lookPitch: number;
        animState: string;
        animTime: number;
        yaw: number;
      }
    > = {};
    for (const [id, player] of this.state.players.entries()) {
      snapshot[id] = {
        id,
        position: { x: player.x, y: player.y, z: player.z },
        velocity: { x: player.vx, y: player.vy, z: player.vz },
        health: player.health,
        stamina: player.stamina,
        lookYaw: player.lookYaw,
        lookPitch: player.lookPitch,
        animState: player.animState,
        animTime: player.animTime,
        yaw: player.yaw,
      };
    }
    this.broadcast(PROTOCOL.snapshot, {
      players: snapshot,
      heat: this.state.heat,
      phase: this.state.phase,
    });
    // Spatial culling: only send crowd agents near players
    this.crowdUpdateCounter++;
    const nearAgents = this.crowd.filter((agent) => {
      // Check if agent is within radius of any player
      for (const player of this.state.players.values()) {
        const dx = agent.x - player.x;
        const dz = agent.z - player.z;
        const distSq = dx * dx + dz * dz;
        if (distSq < this.CROWD_NEAR_RADIUS * this.CROWD_NEAR_RADIUS) {
          return true;
        }
      }
      return false;
    });

    // Only send crowd update every 2 ticks to save bandwidth
    if (this.crowdUpdateCounter % 2 === 0) {
      this.broadcast(PROTOCOL.crowd, {
        agents: nearAgents.map((agent) => ({
          id: agent.id,
          position: { x: agent.x, y: agent.y, z: agent.z },
          velocity: { x: agent.vx, y: agent.vy, z: agent.vz },
          state: agent.state,
          stateTime: agent.stateTime,
        })),
      });
    }
  }
}
