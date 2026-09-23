import { useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';

import { Home } from './pages/Home';
import { Room } from './pages/Room';
import { Rules } from './pages/Rules';
import { useStore } from './store';

export function App() {
  const { pathname } = useLocation();
  // An error belongs to the page it happened on.
  useEffect(() => {
    useStore.getState().dismissError();
  }, [pathname]);

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/room/:code" element={<Room />} />
      <Route path="/rules" element={<Rules />} />
    </Routes>
  );
}
