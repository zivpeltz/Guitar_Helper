// Typed client for the FastAPI backend.

export interface SearchResult {
  songId: number;
  artist: string;
  title: string;
  hasPlayer: boolean;
  guitarTracks: number;
  trackCount: number;
}

export interface LibraryItem {
  key: string;
  title: string;
  artist: string;
  origin: 'songsterr' | 'local';
  openedAt: number;
}

export interface SyncPoint {
  barIndex: number;
  occurrence: number;
  seconds: number;
}

export interface Candidate {
  videoId: string;
  title: string;
  channel: string;
  duration?: number;
  score?: number;
}

export type SourceKind = 'original' | 'backing' | 'solo' | 'separated' | 'separated-guitar';

export interface AudioSource {
  id: string;
  kind: SourceKind;
  label: string;
  provider: 'songsterr' | 'youtube' | 'demucs';
  videoId?: string;
  videoTitle?: string;
  syncPoints?: SyncPoint[] | null;
  syncFrom?: string;
  syncMethod?: string;
  offset?: number;
  trackHashes?: string[];
  guitarOnlyRemoved?: boolean;
  experimental?: boolean;
  partId?: string;
  partHash?: string | null;
  candidates?: Candidate[];
  ready: boolean;
}

export interface SongTrack {
  index: number;
  name: string;
  instrument: string;
  hash: string;
  kind: 'guitar' | 'bass' | 'drums' | 'vocals' | 'other';
  strings?: number;
  difficulty?: number;
  views: number;
  isEmpty: boolean;
}

export interface Song {
  key: string;
  origin: 'songsterr' | 'local';
  title: string;
  artist: string;
  tracks?: SongTrack[];
  defaultTrack?: number;
  measureCount?: number;
  sources: AudioSource[];
}

export interface Job {
  id: string | null;
  title?: string;
  state: 'queued' | 'running' | 'done' | 'error';
  progress: number;
  message: string;
  error: string | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Safari can't reliably play Ogg/Opus; ask the server for an AAC copy there. */
const AUDIO_FORMAT = (() => {
  if (typeof document === 'undefined') return 'ogg';
  const a = document.createElement('audio');
  return a.canPlayType('audio/ogg; codecs="opus"') ? 'ogg' : 'aac';
})();

export const api = {
  search: (q: string) => req<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`),
  library: () => req<LibraryItem[]>('/api/library'),
  deleteSong: (key: string) => req<{ ok: boolean }>(`/api/songs/${key}`, { method: 'DELETE' }),
  openSongsterr: (songId: number, refresh = false) =>
    req<Song>(`/api/songs/songsterr/${songId}?refresh=${refresh}`, { method: 'POST' }),
  uploadLocal: (file: File, title: string, artist: string) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('title', title);
    fd.append('artist', artist);
    return req<Song>('/api/songs/local', { method: 'POST', body: fd });
  },
  song: (key: string) => req<Song>(`/api/songs/${key}`),
  track: (key: string, index: number) => req<unknown>(`/api/songs/${key}/tracks/${index}`),
  tab: async (key: string) => {
    const res = await fetch(`/api/songs/${key}/tab`);
    if (!res.ok) throw new Error('could not load tab file');
    return new Uint8Array(await res.arrayBuffer());
  },
  discover: (key: string) => req<Job>(`/api/songs/${key}/discover`, { method: 'POST' }),
  prepare: (key: string, sourceId: string, force = false) =>
    req<Job>(`/api/songs/${key}/sources/${sourceId}/prepare?force=${force}`, { method: 'POST' }),
  chooseVideo: (key: string, sourceId: string, videoId: string) =>
    req<Song>(`/api/songs/${key}/sources/${sourceId}/video`, json({ videoId })),
  setSync: (key: string, sourceId: string, body: { offset?: number; syncPoints?: SyncPoint[] }) =>
    req<Song>(`/api/songs/${key}/sources/${sourceId}/sync`, { ...json(body), method: 'PUT' }),
  align: (key: string, sourceId: string, midiBase64: string, bars: { barIndex: number; occurrence: number; tick: number }[]) =>
    req<Job>(`/api/songs/${key}/sources/${sourceId}/align`, json({ midi: midiBase64, bars })),
  splitPart: (key: string, partId: string, body: PartSplitRequest, force = false) =>
    req<Job>(`/api/songs/${key}/parts/${partId}/split?force=${force}`, json(body)),
  job: (id: string) => req<Job>(`/api/jobs/${id}`),
  audioUrl: (key: string, sourceId: string) => `/api/songs/${key}/audio/${sourceId}?format=${AUDIO_FORMAT}`,
};

export interface PartSplitRequest {
  label: string;
  hash?: string | null;
  midi: string;
  bars: { barIndex: number; occurrence: number; tick: number }[];
  targetChannels: number[];
  otherChannels: number[];
}

/** Poll a job until it finishes. */
export async function waitForJob(job: Job, onProgress?: (j: Job) => void): Promise<Job> {
  let current = job;
  onProgress?.(current);
  while (current.id && (current.state === 'queued' || current.state === 'running')) {
    await new Promise((r) => setTimeout(r, 700));
    current = await api.job(current.id);
    onProgress?.(current);
  }
  if (current.state === 'error') throw new Error(current.error ?? 'job failed');
  return current;
}
