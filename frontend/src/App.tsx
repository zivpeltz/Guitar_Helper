import { useState } from 'react';
import type { Song } from './api';
import Credits from './components/Credits';
import Home from './components/Home';
import Player from './components/Player';

export default function App() {
  const [song, setSong] = useState<Song | null>(null);
  const [credits, setCredits] = useState(false);
  if (credits) return <Credits onBack={() => setCredits(false)} />;
  return song ? (
    <Player key={song.key} song={song} onSongChange={setSong} onBack={() => setSong(null)} />
  ) : (
    <Home onOpen={setSong} onCredits={() => setCredits(true)} />
  );
}
