import colyseusPkg from 'colyseus';
import { RiotRoom } from './rooms/RiotRoom.js';

const port = Number(process.env.PORT ?? 2567);

const { Server } = colyseusPkg as typeof import('colyseus');
const gameServer = new Server();

gameServer.define('riot_room', RiotRoom).enableRealtimeListing();

gameServer.listen(port);
console.log(`Game server listening on ws://localhost:${port}`);

process.on('SIGTERM', () => {
  gameServer.gracefullyShutdown();
});

process.on('SIGINT', () => {
  gameServer.gracefullyShutdown();
});
