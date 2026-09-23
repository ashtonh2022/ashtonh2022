import { PROTOCOL_VERSION, type ClientMessage } from '@landlord/protocol';

import { secureRandom, systemClock, type Clock, type RandomSource } from './clock';
import { Connection, HELLO_LIMIT, type ConnectionHandler, type Transport } from './connection';
import { consoleLogger, type Logger } from './log';
import { cleanName, PlayerRegistry, type Player } from './players';
import type { Room, RoomResult } from './room';
import { DEFAULT_ROOM_TTL_MS, RoomManager } from './rooms';

/** Rooms the server holds at most unless configured otherwise (env MAX_ROOMS). */
export const DEFAULT_MAX_ROOMS = 500;
export const SERVER_FULL_MESSAGE = 'The server is full right now. Try again later.';

export interface HubOptions {
  clock?: Clock;
  random?: RandomSource;
  log?: Logger;
  roomTtlMs?: number;
  /**
   * Most rooms held at once. When full, create_room closes the room nobody has been connected to
   * for longest; it is refused (rate_limited) only while every room has somebody connected.
   */
  maxRooms?: number;
}

/**
 * The game server minus the network: owns the players, the rooms and the live connections and
 * routes every decoded client message to the right room. `server.ts` plugs WebSockets into it,
 * tests plug in fakes.
 */
export class Hub implements ConnectionHandler {
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly log: Logger;
  readonly players: PlayerRegistry;
  readonly rooms: RoomManager;
  private readonly connections = new Set<Connection>();
  private readonly roomTtlMs: number;
  private readonly maxRooms: number;

  constructor(options: HubOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? secureRandom;
    this.log = options.log ?? consoleLogger;
    this.roomTtlMs = options.roomTtlMs ?? DEFAULT_ROOM_TTL_MS;
    this.maxRooms = options.maxRooms ?? DEFAULT_MAX_ROOMS;
    this.players = new PlayerRegistry({ random: this.random });
    this.rooms = new RoomManager({
      clock: this.clock,
      random: this.random,
      players: this.players,
      log: this.log,
      ttlMs: this.roomTtlMs,
      onSweep: () => this.players.sweep(),
    });
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Starts the periodic room sweep. */
  start(): void {
    this.rooms.startSweeper();
  }

  /** Stops timers and drops every connection (shutdown). */
  stop(): void {
    this.rooms.stopSweeper();
    for (const connection of [...this.connections])
      connection.terminate(1001, 'server shutting down');
    this.rooms.clear();
  }

  /** Wraps a freshly opened socket. Feed its frames to `connection.receive`. */
  connect(transport: Transport): Connection {
    const connection = new Connection(transport, this, this.clock, this.log);
    this.connections.add(connection);
    return connection;
  }

  // -------------------------------------------------------------------------
  // ConnectionHandler
  // -------------------------------------------------------------------------

  onMessage(connection: Connection, message: ClientMessage): void {
    if (message.type === 'hello') {
      this.hello(connection, message);
      return;
    }
    const player = connection.player;
    if (player === null) {
      connection.error('bad_message', 'send hello first');
      return;
    }
    switch (message.type) {
      case 'ping':
        connection.send({ type: 'pong' });
        return;
      case 'set_name': {
        const name = cleanName(message.name);
        if (name === null) {
          connection.error('bad_message', 'that name is empty');
          return;
        }
        player.name = name;
        this.roomOf(player)?.broadcast();
        return;
      }
      case 'create_room': {
        // Both checks come before anything changes, so a refusal costs the player nothing. A full
        // server makes space by closing a room nobody is connected to: rooms left behind by
        // throwaway connections must not lock everyone else out until they expire.
        if (!this.rooms.hasSpace(this.maxRooms)) {
          connection.error('rate_limited', SERVER_FULL_MESSAGE);
          return;
        }
        if (!connection.allowRoomCreation()) {
          connection.error(
            'rate_limited',
            'You are creating rooms too quickly. Try again in a minute.',
          );
          return;
        }
        this.rooms.makeSpace(this.maxRooms);
        const current = this.roomOf(player);
        if (current !== undefined) this.leaveRoom(player, current);
        this.rooms.create(player, message.rules).broadcast();
        return;
      }
      case 'join_room': {
        const room = this.rooms.get(message.code);
        if (room === undefined) {
          connection.error('room_not_found', 'no room with that code');
          return;
        }
        const current = this.roomOf(player);
        if (current !== room) {
          // Check the target first: a full room must not cost the player their current one.
          const refused = room.canJoin(player);
          if (refused !== null) {
            this.reply(connection, refused);
            return;
          }
          if (current !== undefined) this.leaveRoom(player, current);
        }
        this.reply(connection, room.join(player));
        return;
      }
      case 'leave_room': {
        const room = this.roomOf(player);
        if (room === undefined) {
          connection.send({ type: 'left_room' });
          return;
        }
        this.leaveRoom(player, room);
        return;
      }
      default:
        break;
    }

    const room = this.roomOf(player);
    if (room === undefined) {
      connection.error('not_in_room', 'you are not in a room');
      return;
    }
    switch (message.type) {
      case 'update_rules':
        this.reply(connection, room.updateRules(player, message.rules));
        return;
      case 'sit':
        this.reply(connection, room.sit(player, message.seat));
        return;
      case 'stand':
        this.reply(connection, room.stand(player));
        return;
      case 'add_bot':
        this.reply(connection, room.addBot(player, message.seat));
        return;
      case 'remove_bot':
        this.reply(connection, room.removeBot(player, message.seat));
        return;
      case 'fill_bots':
        this.reply(connection, room.fillBots(player));
        return;
      case 'kick':
        this.reply(connection, room.kick(player, message.seat));
        this.deleteIfAbandoned(room);
        return;
      case 'start_hand':
        this.reply(connection, room.startHand(player));
        return;
      case 'hand_action':
        this.reply(connection, room.handAction(player, message.action));
        return;
      case 'chat':
        this.reply(connection, room.chat(player, message.text));
        return;
      case 'emote':
        this.reply(connection, room.emote(player, message.emote));
        return;
      default:
        connection.error('bad_message', 'unknown message');
    }
  }

  onClose(connection: Connection): void {
    this.connections.delete(connection);
    this.detach(connection);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private hello(connection: Connection, message: Extract<ClientMessage, { type: 'hello' }>): void {
    connection.helloCount += 1;
    if (connection.helloCount > HELLO_LIMIT) {
      connection.error('bad_message', 'too many hello messages on one connection');
      connection.terminate(1008, 'too many hello messages');
      return;
    }
    if (message.protocol !== PROTOCOL_VERSION) {
      connection.error(
        'bad_message',
        `unsupported protocol version ${message.protocol}; this server speaks ${PROTOCOL_VERSION}`,
      );
      connection.terminate(1008, 'unsupported protocol');
      return;
    }
    if (connection.player !== null) this.detach(connection);
    const player = this.players.identify(message.playerId, message.token, message.name);
    connection.player = player;
    player.connections.add(connection);
    connection.send({
      type: 'welcome',
      playerId: player.id,
      token: player.token,
      name: player.name,
      protocol: PROTOCOL_VERSION,
    });
    // A returning player is put straight back into their room.
    this.roomOf(player)?.onConnectionChange(player);
  }

  private detach(connection: Connection): void {
    const player = connection.player;
    if (player === null) return;
    connection.player = null;
    player.connections.delete(connection);
    const room = this.roomOf(player);
    if (room !== undefined) {
      room.onConnectionChange(player);
      this.deleteIfAbandoned(room);
    }
    // Nobody needs a player with no connection and no room; their token brings them back.
    this.players.release(player);
  }

  private roomOf(player: Player): Room | undefined {
    if (player.roomCode === null) return undefined;
    const room = this.rooms.get(player.roomCode);
    if (room === undefined || room.isDestroyed || !room.isMember(player.id)) {
      player.roomCode = null;
      return undefined;
    }
    return room;
  }

  private leaveRoom(player: Player, room: Room): void {
    room.leave(player);
    this.deleteIfAbandoned(room);
  }

  /** A room with no humans left in it (seated or watching) has nobody to come back to it. */
  private deleteIfAbandoned(room: Room): void {
    this.rooms.deleteIfAbandoned(room);
  }

  private reply(connection: Connection, result: RoomResult): void {
    if (result !== null) connection.error(result.code, result.message);
  }
}
