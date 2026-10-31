import { useEffect, useRef, useState } from 'react';
import * as alphaTab from '@coderline/alphatab';
import { api, type LibraryItem, type SearchResult, type Song } from '../api';

interface Props {
  onOpen: (song: Song) => void;
  onCredits: () => void;
}

export default function Home({ onOpen, onCredits }: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.library().then(setLibrary).catch(() => undefined);
  }, []);

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy('search');
    setError(null);
    try {
      setResults(await api.search(q));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const openSongsterr = async (r: SearchResult) => {
    setBusy(`ss-${r.songId}`);
    setError(null);
    try {
      onOpen(await api.openSongsterr(r.songId));
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  const openKey = async (key: string) => {
    setBusy(key);
    try {
      onOpen(await api.song(key));
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  const remove = async (key: string) => {
    await api.deleteSong(key);
    setLibrary((l) => l.filter((x) => x.key !== key));
  };

  const upload = async (file: File) => {
    setBusy('upload');
    setError(null);
    try {
      // Parse locally first so we know title/artist (and fail fast on unreadable files).
      const bytes = new Uint8Array(await file.arrayBuffer());
      const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, new alphaTab.Settings());
      onOpen(await api.uploadLocal(file, score.title || file.name.replace(/\.[^.]+$/, ''), score.artist || ''));
    } catch (err) {
      setError(`Could not open file: ${(err as Error).message}`);
      setBusy(null);
    }
  };

  return (
    <div className="home">
      <div className="hero">
        <h1>
          Guitar <em>Helper</em>
        </h1>
        <p>Search a song, read the tab, and play along with the real recording or a no-guitar backing track.</p>
        <form className="search" onSubmit={search}>
          <input
            autoFocus
            placeholder="Song or artist, e.g. “Wonderwall”"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit" disabled={busy === 'search'}>
            {busy === 'search' ? 'Searching…' : 'Search'}
          </button>
        </form>
        <div className="upload">
          or{' '}
          <button className="link" onClick={() => fileRef.current?.click()} disabled={busy === 'upload'}>
            open a Guitar Pro / MusicXML file
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            accept=".gp,.gp3,.gp4,.gp5,.gpx,.musicxml,.xml,.mxl,.cap,.tex"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>

      {results && (
        <section>
          <h2>Results</h2>
          {results.length === 0 && <p className="muted">Nothing found.</p>}
          <ul className="list">
            {results.map((r) => (
              <li key={r.songId}>
                <button className="row-btn" onClick={() => openSongsterr(r)} disabled={!!busy}>
                  <span className="t">{r.title}</span>
                  <span className="a">{r.artist}</span>
                  <span className="meta">
                    {r.guitarTracks} guitar part{r.guitarTracks === 1 ? '' : 's'}
                    {busy === `ss-${r.songId}` && ' · loading…'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {library.length > 0 && (
        <section>
          <h2>Recently opened</h2>
          <ul className="list">
            {library.map((s) => (
              <li key={s.key}>
                <button className="row-btn" onClick={() => openKey(s.key)} disabled={!!busy}>
                  <span className="t">{s.title}</span>
                  <span className="a">{s.artist}</span>
                  <span className="meta">{s.origin === 'local' ? 'local file' : 'Songsterr'}</span>
                </button>
                <button className="ghost small" title="Remove from library (deletes cached audio)" onClick={() => remove(s.key)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="muted small-print">
        Tabs and synced audio come from Songsterr and YouTube. Everything is cached locally for personal practice only.{' '}
        <button className="link" onClick={onCredits}>
          Credits &amp; legal
        </button>
      </footer>
    </div>
  );
}
