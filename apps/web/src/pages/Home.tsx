import { Link } from 'react-router-dom';

export function Home() {
  return (
    <main>
      <h1>Landlord</h1>
      <p>A web version of Dou Dizhu.</p>
      <Link to="/rules">Rules</Link>
    </main>
  );
}
