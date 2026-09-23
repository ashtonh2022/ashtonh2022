import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { ChatPanel } from '../components/Chat';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Lobby } from '../components/Lobby';
import { RoomNoticeBanner, StatusBanner, Toast } from '../components/Notices';
import { Table } from '../components/Table';
import { TopBar } from '../components/TopBar';
import { fmt } from '../lib/format';
import { client, ensureConnected, send } from '../net/session';
import { useStore } from '../store';
import { strings } from '../strings';
import { normalizeCode } from './Home';

let mountedRoomPages = 0;

/**
 * Forgets the room when the page goes away (browser back, a link home), so no other page acts on
 * a room the player is no longer looking at. Deferred a tick so React's StrictMode remount of the
 * same page does not drop it.
 */
function useForgetRoomOnUnmount(): void {
  useEffect(() => {
    mountedRoomPages += 1;
    return () => {
      mountedRoomPages -= 1;
      setTimeout(() => {
        if (mountedRoomPages === 0) useStore.getState().clearRoom();
      }, 0);
    };
  }, []);
}

export function Room() {
  const params = useParams();
  const code = normalizeCode(params.code ?? '');
  const navigate = useNavigate();
  const room = useStore((state) => state.room);
  const roomNotFound = useStore((state) => state.roomNotFound);
  const joinError = useStore((state) => state.joinError);
  const status = useStore((state) => state.status);
  const kickedFrom = useStore((state) => state.kickedFrom);
  const hadRoom = useRef(false);
  /** hand number the Leave confirmation was asked for */
  const [confirmLeaveFor, setConfirmLeaveFor] = useState<number | null>(null);

  useForgetRoomOnUnmount();

  useEffect(() => {
    ensureConnected();
    useStore.getState().beginJoin(code);
    client.joinRoom(code);
    return () => {
      client.joinRoom(null);
    };
  }, [code]);

  // Kicked or the room closed: go home (Home says why when the host removed us). A kick from this
  // room counts even before it showed: the link reopened after the host removed us while away.
  useEffect(() => {
    if (room && room.code === code) {
      hadRoom.current = true;
      return;
    }
    if (room !== null) return;
    // Read fresh: opening the page (beginJoin, above) has just cleared an older kick.
    const kickedHere = useStore.getState().kickedFrom?.code === code;
    if (hadRoom.current || kickedHere) {
      hadRoom.current = false;
      navigate('/');
    }
  }, [room, code, navigate, kickedFrom]);

  const leave = () => {
    setConfirmLeaveFor(null);
    hadRoom.current = false;
    send({ type: 'leave_room' });
    client.joinRoom(null);
    useStore.getState().clearRoom();
    navigate('/');
  };

  // Leaving mid-hand hands the seat to a bot for good, so ask first.
  const leaveCostsSeat = room?.status === 'playing' && room.you.seat !== null;
  const requestLeave = () => {
    if (room && leaveCostsSeat) setConfirmLeaveFor(room.handNumber);
    else leave();
  };

  const retry = () => {
    useStore.getState().dismissError();
    useStore.getState().beginJoin(code);
    client.joinRoom(code);
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
    if (joinError) {
      return (
        <main className="page centered">
          <StatusBanner status={status} />
          <h1 className="home-title">{strings.appName}</h1>
          <p>{fmt(strings.joinFailed, { code })}</p>
          <p role="alert" className="join-error">
            {joinError.message || strings.errorTitle}
          </p>
          <div className="button-row button-row-center">
            <button type="button" className="button button-primary" onClick={retry}>
              {strings.retry}
            </button>
            <Link to="/" className="button">
              {strings.backHome}
            </Link>
          </div>
        </main>
      );
    }
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
      <TopBar code={room.code} onLeave={requestLeave} />
      <StatusBanner status={status} />
      <main className={playing ? 'room-main room-playing' : 'room-main page'}>
        <RoomNoticeBanner code={room.code} />
        {playing && room.hand ? <Table room={room} hand={room.hand} /> : <Lobby room={room} />}
      </main>
      <ChatPanel room={room} />
      <Toast />
      {leaveCostsSeat && confirmLeaveFor === room.handNumber && (
        <ConfirmDialog
          message={strings.leaveConfirm}
          confirmLabel={strings.leave}
          onCancel={() => setConfirmLeaveFor(null)}
          onConfirm={leave}
        />
      )}
    </div>
  );
}
