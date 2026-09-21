import { useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ChatPanel } from '../components/Chat';
import { Lobby } from '../components/Lobby';
import { StatusBanner, Toast } from '../components/Notices';
import { Table } from '../components/Table';
import { TopBar } from '../components/TopBar';
import { fmt } from '../lib/format';
import { client, ensureConnected, send } from '../net/session';
import { useStore } from '../store';
import { strings } from '../strings';
import { normalizeCode } from './Home';

export function Room() {
  const params = useParams();
  const code = normalizeCode(params.code ?? '');
  const navigate = useNavigate();
  const room = useStore((state) => state.room);
  const roomNotFound = useStore((state) => state.roomNotFound);
  const status = useStore((state) => state.status);
  const hadRoom = useRef(false);

  useEffect(() => {
    ensureConnected();
    useStore.getState().resetRoomNotFound();
    client.joinRoom(code);
    return () => {
      client.joinRoom(null);
    };
  }, [code]);

  // Kicked or the room closed: go home.
  useEffect(() => {
    if (room && room.code === code) {
      hadRoom.current = true;
    } else if (room === null && hadRoom.current) {
      hadRoom.current = false;
      navigate('/');
    }
  }, [room, code, navigate]);

  const leave = () => {
    hadRoom.current = false;
    send({ type: 'leave_room' });
    client.joinRoom(null);
    useStore.getState().clearRoom();
    navigate('/');
  };

  if (roomNotFound) {
    return (
      <main className="page centered">
        <h1 className="home-title">{strings.appName}</h1>
        <p role="alert">{strings.roomNotFound}</p>
        <Link to="/" className="button button-primary">
          {strings.backHome}
        </Link>
      </main>
    );
  }

  if (!room || room.code !== code) {
    return (
      <main className="page centered">
        <StatusBanner status={status} />
        <h1 className="home-title">{strings.appName}</h1>
        <p role="status">{fmt(strings.joiningRoom, { code })}</p>
        <Link to="/" className="link">
          {strings.backHome}
        </Link>
        <Toast />
      </main>
    );
  }

  const playing = room.status === 'playing' && room.hand !== null;

  return (
    <div className="room">
      <TopBar code={room.code} onLeave={leave} />
      <StatusBanner status={status} />
      <main className={playing ? 'room-main room-playing' : 'room-main page'}>
        {playing && room.hand ? <Table room={room} hand={room.hand} /> : <Lobby room={room} />}
      </main>
      <ChatPanel room={room} />
      <Toast />
    </div>
  );
}
