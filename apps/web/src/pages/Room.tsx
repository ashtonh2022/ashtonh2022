import { useParams } from 'react-router-dom';

export function Room() {
  const { code } = useParams();
  return (
    <main>
      <h1>Room {code}</h1>
    </main>
  );
}
