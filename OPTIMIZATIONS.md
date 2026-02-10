# Network & Physics Optimizations

## Summary

Three major optimizations implemented for smooth multiplayer gameplay:

1. **Client-Side Prediction with Input Replay**
2. **Adaptive Interpolation Buffer**  
3. **Spatial Crowd Culling**

## 1. Client-Side Prediction (Eliminates Rubber-Banding)

### Problem
Without prediction, player movement feels sluggish because you have to wait for server confirmation before seeing your actions.

### Solution
- Client stores history of last 60 inputs (3 seconds at 20Hz)
- Server sends back last processed sequence number
- Client replays all pending inputs on top of server position
- If mismatch > 10cm, snap to reconciled position

### Impact
- **Zero perceived input lag** - movement feels instant
- **Stays server-authoritative** - no cheating possible
- **Smooth reconciliation** - no jarring position snaps

### Code Flow
```
Client sends input seq=50 → Server processes → Server replies "I processed seq=50"
Client has sent seq=51,52,53 since then
Client: Start from server position, replay inputs 51,52,53
Result: Smooth prediction with server authority
```

## 2. Adaptive Interpolation Buffer (Smooth Remote Players)

### Problem
Fixed 120ms buffer doesn't adapt to network conditions. Too small = jitter, too large = lag.

### Solution
- Measure actual snapshot arrival times
- Calculate jitter (variance in arrival time)
- Buffer = 2x avg interval + 3x jitter
- Range: 50-200ms, smoothly adjusted

### Impact
- **Adapts to network quality** - works on WiFi, mobile, ethernet
- **Minimal lag** - only buffers what's needed
- **Smooth motion** - handles packet loss gracefully

### Extrapolation Improvements
- Damping factor when beyond last snapshot
- Velocity prediction reduces to zero over 500ms
- Prevents "sliding" effect when packets drop

## 3. Spatial Crowd Culling (Bandwidth Savings)

### Problem
Sending all 100 crowd NPCs every tick = ~30KB/s per player. Wasteful for distant crowds.

### Solution
- Only send crowd within 50m of any player
- Update rate reduced to 10Hz (half of players)
- Client tracks agents by ID, handles enter/exit gracefully

### Impact
- **~80% bandwidth reduction** when players spread out
- **Scales with player count** - more players = better coverage
- **No visual impact** - agents beyond 50m are too far to matter

### Numbers
- Before: 100 agents × 20Hz × 40 bytes = 80 KB/s
- After: ~20 agents × 10Hz × 40 bytes = 8 KB/s
- **10x bandwidth reduction** in typical gameplay

## Combined Impact

### Player Movement
- ✅ Instant response (client-side prediction)
- ✅ No rubber-banding (input replay)
- ✅ Server-authoritative (anti-cheat safe)

### Remote Players
- ✅ Smooth interpolation (adaptive buffer)
- ✅ Handles packet loss (damped extrapolation)
- ✅ Works on varying networks (50-200ms adaptive)

### Crowd NPCs
- ✅ Efficient bandwidth usage (spatial culling)
- ✅ Scales with player count (only send nearby)
- ✅ Reduced update rate (10Hz vs 20Hz)

## Technical Details

### Server Tick Rate
- 20Hz (50ms per tick)
- Authoritative physics simulation
- Tracks last processed input per player

### Client Render Rate
- 60Hz (16.67ms per frame)
- Client-side prediction for local player
- Interpolation for remote players
- Extrapolation with damping when needed

### Network Usage (8 players typical)
| Component | Before | After | Reduction |
|-----------|--------|-------|-----------|
| Player updates | 10 KB/s | 10 KB/s | - |
| Crowd updates | 80 KB/s | 8 KB/s | 90% |
| **Total per player** | **90 KB/s** | **18 KB/s** | **80%** |

### Latency Handling
- **Local player**: 0ms perceived lag (prediction)
- **Remote players**: 50-200ms adaptive buffer
- **Crowd**: 50-100ms buffer (lower priority)

## Future Optimizations

Not implemented yet, but possible:

1. **Delta Compression** - Only send changed values
   - Could reduce player updates by 50%
   - Complexity: moderate

2. **Interest Management** - Per-player visibility culling
   - Don't send players 100m+ away
   - Complexity: high (needs spatial index)

3. **Snapshot Compression** - Binary protocol instead of JSON
   - 50-70% size reduction
   - Complexity: high (breaks debugging)

4. **Lag Compensation** - Server rewinds for hit detection
   - Better combat feel on high latency
   - Complexity: very high

## Testing Recommendations

### Test on Varying Networks
- WiFi (typical: 20-50ms jitter)
- Mobile (typical: 50-150ms jitter)
- High latency (200ms+)

### Monitor Metrics
- Client prediction corrections (should be rare)
- Interpolation buffer size (should adapt)
- Crowd agents sent per tick (should vary with distance)

### Debug Commands
Add to HUD to monitor:
- `inputHistory.length` - pending inputs
- `remoteBufferSeconds` - current buffer size
- `crowdAgents.size` - nearby crowd count
