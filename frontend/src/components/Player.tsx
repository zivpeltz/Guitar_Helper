import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as alphaTab from '@coderline/alphatab';
import { api, waitForJob, type AudioSource, type PartSplitRequest, type Job, type Song, type SongTrack } from '../api';
import { songsterrToScore, type SongsterrTrack } from '../lib/songsterrToScore';
import { beatIndexAt, beatsFor, playbackBars, RecordingMetronome, tickToSeconds, type Beat } from '../lib/metronome';
import {
  bestNoGuitarSource,
  exportMidiForAlignment,
  fmtTime,
  hasSync,
  timelineOwner,
  toFlatSyncPoints,
} from '../lib/alphatabSync';

const SYNTH_ID = 'synth';
const VOLUME_KEY = 'gh.volume';
const METRO_VOLUME_KEY = 'gh.metronomeVolume';

/** A selectable part: a 6-string guitar track in the loaded score. */
interface Part {
  scoreIndex: number;
  name: string;
  track?: SongTrack; // Songsterr metadata, when the song comes from Songsterr
}

/** Stable id of a part across sessions: Songsterr track index, else score track index. */
const partIdOf = (p: Part) => `p${p.track?.index ?? p.scoreIndex}`;
const PART_SOURCE_RE = /^ai-(no|only)part-(p\d+)$/;
const partSourceIds = (p: Part) => ({ no: `ai-nopart-${partIdOf(p)}`, only: `ai-onlypart-${partIdOf(p)}` });
const shortPartName = (p: Part) => p.name.split('|').pop()!.trim() || p.name;

/** Request body for the experimental per-part split: the score's MIDI + which channels are which part. */
function splitRequest(at: alphaTab.AlphaTabApi, part: Part, all: Part[]): PartSplitRequest {
  const channelsOf = (p: Part) => {
    const pi = at.score!.tracks[p.scoreIndex].playbackInfo;
    return [pi.primaryChannel, pi.secondaryChannel];
  };
  const { midiBase64, bars } = exportMidiForAlignment(at.score!, at.settings);
  return {
    label: shortPartName(part),
    hash: part.track?.hash ?? null,
    midi: midiBase64,
    bars,
    targetChannels: channelsOf(part),
    otherChannels: all.filter((p) => p !== part).flatMap(channelsOf),
  };
}

const isSixStringSongsterr = (t: SongTrack) => !t.isEmpty && t.kind === 'guitar' && (t.strings ?? 6) === 6;

/** Guitar-Pro / MusicXML tracks: 6-string, non-percussion, guitar programs (GM 24–31) preferred. */
function sixStringGuitarTracks(score: alphaTab.model.Score): number[] {
  const six = score.tracks.filter(
    (t) => !t.isPercussion && t.staves.some((st) => !st.isPercussion && st.tuning.length === 6),
  );
  const isGuitarProgram = (p: number) => p >= 24 && p <= 31;
  const isBassProgram = (p: number) => p >= 32 && p <= 39;
  const strict = six.filter((t) => isGuitarProgram(t.playbackInfo.program));
  return (strict.length ? strict : six.filter((t) => !isBassProgram(t.playbackInfo.program))).map((t) => t.index);
}

function loadVolume(key = VOLUME_KEY, fallback = 1): number {
  try {
    const v = parseFloat(localStorage.getItem(key) ?? '');
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
  } catch {
    return fallback;
  }
}

interface Props {
  song: Song;
  onSongChange: (song: Song) => void;
  onBack: () => void;
}

interface Task {
  key: string;
  message: string;
  progress: number;
  error?: string;
}

export default function Player({ song, onSongChange, onBack }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const apiRef = useRef<alphaTab.AlphaTabApi | null>(null);
  const songRef = useRef(song);
  songRef.current = song;
  const loadTokenRef = useRef(0);

  const [parts, setParts] = useState<Part[]>([]);
  const partsRef = useRef(parts);
  partsRef.current = parts;
  const [trackIdx, setTrackIdx] = useState(0);
  const [sourceId, setSourceId] = useState<string>('');
  const [playing, setPlaying] = useState(false);
  // A source that was selected but isn't playable yet (downloading / AI-separating / syncing).
  // The previously active source keeps playing until it's ready.
  const [pending, setPending] = useState<{ id: string; label: string; taskKey: string } | null>(null);
  const [time, setTime] = useState({ cur: 0, dur: 0 });
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(() => loadVolume());
  const [metroOn, setMetroOn] = useState(false);
  const [metroVol, setMetroVol] = useState(() => loadVolume(METRO_VOLUME_KEY, 0.7));
  const [metroBeat, setMetroBeat] = useState<{ beat: number; of: number } | null>(null);
  const [metroSynced, setMetroSynced] = useState(true);
  const beatsRef = useRef<Beat[]>([]);
  const metroRef = useRef<RecordingMetronome | null>(null);
  const metroVolRef = useRef(metroVol);
  metroVolRef.current = metroVol;
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const [looping, setLooping] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [tabOnly, setTabOnly] = useState(false);
  const [horizontal, setHorizontal] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [tasks, setTasks] = useState<Record<string, Task>>({});
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const currentTrack: SongTrack | undefined = parts[trackIdx]?.track;
  const source = song.sources.find((s) => s.id === sourceId);
  const original = song.sources.find((s) => s.id === 'original');
  const noGuitar = useMemo(() => bestNoGuitarSource(song, currentTrack), [song, currentTrack]);

  // ------------------------------------------------------------------ tasks
  const runTask = useCallback(async <T,>(key: string, message: string, fn: (report: (j: Job) => void) => Promise<T>) => {
    setTasks((t) => ({ ...t, [key]: { key, message, progress: 0 } }));
    try {
      const r = await fn((j) =>
        setTasks((t) => ({ ...t, [key]: { key, message: j.message || message, progress: j.progress } })),
      );
      setTasks((t) => {
        const { [key]: _, ...rest } = t;
        return rest;
      });
      return r;
    } catch (e) {
      setTasks((t) => ({ ...t, [key]: { key, message, progress: 1, error: (e as Error).message } }));
      throw e;
    }
  }, []);

  const refreshSong = useCallback(async () => {
    const s = await api.song(songRef.current.key);
    songRef.current = s;
    onSongChange(s);
    return s;
  }, [onSongChange]);

  // ------------------------------------------------------------------ alphaTab setup
  useEffect(() => {
    const host = hostRef.current!;
    const settings = new alphaTab.Settings();
    settings.player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia;
    settings.player.enableCursor = true;
    settings.player.enableAnimatedBeatCursor = true;
    settings.player.enableUserInteraction = true;
    settings.player.scrollElement = viewportRef.current!;
    settings.player.scrollOffsetY = -30;
    settings.core.fontDirectory = '/font/'; // copied to the web root by the alphaTab Vite plugin
    settings.player.soundFont = '/soundfont/sonivox.sf2';
    settings.display.layoutMode = alphaTab.LayoutMode.Page;
    settings.display.resources.mainGlyphColor = alphaTab.model.Color.fromJson('#1d1b16')!;

    const at = new alphaTab.AlphaTabApi(host, settings);
    apiRef.current = at;

    at.renderStarted.on(() => setRendering(true));
    at.renderFinished.on(() => setRendering(false));
    at.error.on((e) => setError(String((e as Error).message ?? e)));
    at.playerReady.on(() => {
      at.masterVolume = volumeRef.current;
    });
    at.playerStateChanged.on((e) => setPlaying(e.state === alphaTab.synth.PlayerState.Playing));
    at.playbackRangeChanged.on((e) => setHasSelection(!!e.playbackRange));
    at.playerPositionChanged.on((e) => {
      if (at.settings.player.playerMode === alphaTab.PlayerMode.EnabledSynthesizer) {
        setTime({ cur: e.currentTime / 1000, dur: e.endTime / 1000 });
      }
    });
    const noParts = () => setError('This song has no 6-string guitar part.');

    // ---- load the tab (6-string guitar parts only)
    let cancelled = false;
    (async () => {
      try {
        const s = songRef.current;
        if (s.origin === 'songsterr') {
          const candidates = (s.tracks ?? []).filter(isSixStringSongsterr);
          const all = (await Promise.all(candidates.map((t) => api.track(s.key, t.index)))) as SongsterrTrack[];
          if (cancelled) return;
          // the notation JSON is authoritative for the string count (older cached metadata lacks it)
          const keep = candidates.map((t, i) => ({ t, d: all[i] })).filter(({ d }) => (d.strings ?? d.tuning?.length ?? 6) === 6);
          if (!keep.length) return noParts();
          const tracks = keep.map((k) => k.t);
          const score = songsterrToScore(s.title, s.artist, tracks, keep.map((k) => k.d), at.settings);
          const def = Math.max(0, tracks.findIndex((t) => t.index === s.defaultTrack));
          setParts(score.tracks.map((t, i) => ({ scoreIndex: i, name: t.name || `Guitar ${i + 1}`, track: tracks[i] })));
          setTrackIdx(def);
          at.renderScore(score, [def]);
        } else {
          const bytes = await api.tab(s.key);
          if (cancelled) return;
          const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, at.settings);
          const guitars = sixStringGuitarTracks(score);
          if (!guitars.length) return noParts();
          setParts(guitars.map((i) => ({ scoreIndex: i, name: score.tracks[i].name || `Guitar ${i + 1}` })));
          setTrackIdx(0);
          at.renderScore(score, [guitars[0]]);
        }
      } catch (e) {
        setError(`Could not load tab: ${(e as Error).message}`);
      }
    })();

    return () => {
      cancelled = true;
      at.destroy();
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.key]);

  // ------------------------------------------------------------------ audio element <-> alphaTab
  const attachHandler = useCallback(() => {
    const at = apiRef.current;
    const audio = audioRef.current;
    if (!at || !audio || !at.player) return;
    const output = at.player.output as unknown as alphaTab.synth.IExternalMediaSynthOutput;
    if (!('handler' in output) && !('updatePosition' in output)) return;
    output.handler = {
      get backingTrackDuration() {
        return Number.isFinite(audio.duration) ? audio.duration * 1000 : 0;
      },
      get playbackRate() {
        return audio.playbackRate;
      },
      set playbackRate(v: number) {
        audio.playbackRate = v;
      },
      get masterVolume() {
        return audio.volume;
      },
      set masterVolume(v: number) {
        audio.volume = v;
      },
      seekTo(ms: number) {
        audio.currentTime = ms / 1000;
      },
      play() {
        audio.play().catch(() => undefined);
      },
      pause() {
        audio.pause();
      },
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current!;
    let timer: number | undefined;
    const output = () => {
      const at = apiRef.current;
      if (!at?.player || at.settings.player.playerMode !== alphaTab.PlayerMode.EnabledExternalMedia) return null;
      return at.player.output as unknown as alphaTab.synth.IExternalMediaSynthOutput;
    };
    const update = () => {
      output()?.updatePosition(audio.currentTime * 1000);
      setTime({ cur: audio.currentTime, dur: Number.isFinite(audio.duration) ? audio.duration : 0 });
    };
    const onPlay = () => {
      window.clearInterval(timer);
      timer = window.setInterval(update, 50);
      if (output()) apiRef.current?.play();
    };
    const onPause = () => {
      window.clearInterval(timer);
      if (output()) apiRef.current?.pause();
    };
    audio.addEventListener('timeupdate', update);
    audio.addEventListener('seeked', update);
    audio.addEventListener('loadedmetadata', update);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onPause);
    return () => {
      window.clearInterval(timer);
      audio.removeEventListener('timeupdate', update);
      audio.removeEventListener('seeked', update);
      audio.removeEventListener('loadedmetadata', update);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onPause);
    };
  }, []);

  /** Beats of the score in playback order, placed in the recording through `src`'s sync points. */
  const computeBeats = useCallback((s: Song, src: AudioSource | undefined) => {
    const at = apiRef.current;
    if (!at?.score) return;
    const bars = playbackBars(at.score, at.settings);
    const owner = src ? timelineOwner(s, src) : undefined;
    const toSec = owner?.syncPoints?.length ? tickToSeconds(bars, owner.syncPoints, owner.offset ?? 0) : null;
    beatsRef.current = beatsFor(bars).map((b) => ({ ...b, time: toSec ? toSec(b.tick) : NaN }));
    metroRef.current?.reset();
  }, []);

  const applySync = useCallback(
    (s: Song, src: AudioSource | undefined) => {
      const at = apiRef.current;
      if (!at?.score) return;
      const pts = src ? toFlatSyncPoints(s, src, at.score.masterBars.length) : [];
      at.score.applyFlatSyncPoints(pts);
      at.updateSyncPoints();
      computeBeats(s, src);
    },
    [computeBeats],
  );

  // ------------------------------------------------------------------ choose / load audio source
  const selectSource = useCallback(
    async (id: string) => {
      const at = apiRef.current;
      const audio = audioRef.current!;
      if (!at) return;
      const token = ++loadTokenRef.current;
      const stale = () => token !== loadTokenRef.current;
      setError(null);
      setPending(null);

      if (id === SYNTH_ID) {
        const wasPlaying = at.playerState === alphaTab.synth.PlayerState.Playing;
        const tick = at.tickPosition;
        at.pause();
        audio.pause();
        audio.removeAttribute('src');
        setSourceId(id);
        at.settings.player.playerMode = alphaTab.PlayerMode.EnabledSynthesizer;
        at.updateSettings();
        at.loadMidiForScore();
        at.masterVolume = volumeRef.current;
        computeBeats(songRef.current, undefined);
        at.tickPosition = tick;
        if (wasPlaying) at.play();
        return;
      }

      let s = songRef.current;
      let src = s.sources.find((x) => x.id === id);
      const partMatch = PART_SOURCE_RE.exec(id);
      const part = partMatch ? partsRef.current.find((p) => partIdOf(p) === partMatch[2]) : undefined;
      if (!src && !part) return;
      try {
        // 1a) EXPERIMENTAL tab-guided split of one guitar part (needs the score, so it's driven from here)
        if (part && !src?.ready && at.score) {
          const name = shortPartName(part);
          const label = `${partMatch![1] === 'no' ? 'No' : 'Only'} ${name} (AI tab-guided)`;
          const taskKey = `part:${partIdOf(part)}`;
          setPending({ id, label, taskKey });
          await runTask(taskKey, `Splitting “${name}” out of the guitars…`, async (report) => {
            await waitForJob(await api.splitPart(s.key, partIdOf(part), splitRequest(at, part, partsRef.current)), report);
          });
          if (stale()) return;
          s = await refreshSong();
          src = s.sources.find((x) => x.id === id);
          if (!src) throw new Error('split finished but the source is missing');
        }
        if (!src) return;
        // 1b) make sure the audio exists on disk — in the background, the current source keeps playing
        if (!src.ready) {
          const label = src.label;
          setPending({ id, label, taskKey: `prep:${id}` });
          await runTask(`prep:${id}`, `Preparing “${label}”…`, async (report) => {
            await waitForJob(await api.prepare(s.key, id), report);
          });
          if (stale()) return;
          s = await refreshSong();
          src = s.sources.find((x) => x.id === id)!;
        }
        if (stale()) return;

        // 2) sync points: ready-made (Songsterr) or computed by auto-alignment (also before switching)
        if (!hasSync(s, src) && at.score) {
          const owner = timelineOwner(s, src);
          setPending({ id, label: src.label, taskKey: `align:${owner.id}` });
          await runTask(`align:${owner.id}`, 'Auto-syncing tab to the recording…', async (report) => {
            const { midiBase64, bars } = exportMidiForAlignment(at.score!, at.settings);
            await waitForJob(await api.align(s.key, owner.id, midiBase64, bars), report);
          });
          if (stale()) return;
          s = await refreshSong();
          src = s.sources.find((x) => x.id === id)!;
        }
        if (stale()) return;

        // 3) now actually switch: load into the <audio> element at the same musical position
        const wasPlaying = at.playerState === alphaTab.synth.PlayerState.Playing;
        const tick = at.tickPosition;
        at.pause();
        audio.pause();
        if (at.settings.player.playerMode !== alphaTab.PlayerMode.EnabledExternalMedia) {
          at.settings.player.playerMode = alphaTab.PlayerMode.EnabledExternalMedia;
          at.updateSettings();
          at.loadMidiForScore();
        }
        setSourceId(id);
        audio.src = `${api.audioUrl(s.key, id)}&v=${encodeURIComponent(src.videoId ?? '')}`;
        await new Promise<void>((resolve, reject) => {
          const ok = () => (cleanup(), resolve());
          const bad = () => (cleanup(), reject(new Error('audio failed to load')));
          const cleanup = () => {
            audio.removeEventListener('loadedmetadata', ok);
            audio.removeEventListener('error', bad);
          };
          audio.addEventListener('loadedmetadata', ok);
          audio.addEventListener('error', bad);
        });
        if (stale()) return;
        audio.playbackRate = at.playbackSpeed;
        audio.volume = volumeRef.current;
        attachHandler();
        at.masterVolume = volumeRef.current;
        applySync(s, src);
        at.tickPosition = tick;
        if (wasPlaying) at.play();
        setPending(null);
      } catch (e) {
        if (!stale()) {
          setPending(null);
          setError((e as Error).message);
        }
      }
    },
    [applySync, attachHandler, computeBeats, refreshSong, runTask],
  );

  /** Stop waiting for a pending source (the server job keeps going and its result is cached). */
  const cancelPending = () => {
    loadTokenRef.current++;
    setPending(null);
  };

  // pick an initial source once the score is rendered
  const initialised = useRef(false);
  useEffect(() => {
    if (initialised.current || !parts.length) return;
    initialised.current = true;
    (async () => {
      let s = songRef.current;
      if (!s.sources.some((x) => x.id === 'original')) {
        try {
          await runTask('discover', 'Searching YouTube for the recording…', async (report) => {
            await waitForJob(await api.discover(s.key), report);
          });
          s = await refreshSong();
        } catch {
          /* shown in task list */
        }
      }
      if (s.sources.some((x) => x.id === 'original')) selectSource('original');
      else selectSource(SYNTH_ID);
    })();
  }, [parts, refreshSong, runTask, selectSource]);

  // ------------------------------------------------------------------ view controls
  useEffect(() => {
    const at = apiRef.current;
    const part = parts[trackIdx];
    if (!at?.score || !part || !at.score.tracks[part.scoreIndex]) return;
    if (at.tracks.length === 1 && at.tracks[0].index === part.scoreIndex) return;
    at.renderTracks([at.score.tracks[part.scoreIndex]]);
  }, [trackIdx, parts]);

  useEffect(() => {
    const at = apiRef.current;
    if (!at) return;
    at.settings.display.staveProfile = tabOnly ? alphaTab.StaveProfile.Tab : alphaTab.StaveProfile.Default;
    at.settings.display.layoutMode = horizontal ? alphaTab.LayoutMode.Horizontal : alphaTab.LayoutMode.Page;
    at.settings.display.scale = zoom;
    at.updateSettings();
    if (at.score) at.render();
  }, [tabOnly, horizontal, zoom]);

  useEffect(() => {
    const at = apiRef.current;
    if (at) at.playbackSpeed = speed;
  }, [speed]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    const at = apiRef.current;
    if (at) at.masterVolume = volume;
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {
      /* per-browser convenience only */
    }
  }, [volume]);

  useEffect(() => {
    const at = apiRef.current;
    if (at) at.isLooping = looping;
  }, [looping]);

  // ------------------------------------------------------------------ metronome
  // Recording: our own clicks, placed through the sync points so they follow the band's tempo.
  // Tab synth: alphaTab's built-in metronome.
  useEffect(() => {
    const at = apiRef.current;
    const audio = audioRef.current;
    const synth = sourceId === SYNTH_ID;
    if (at) at.metronomeVolume = metroOn && synth ? metroVolRef.current : 0;
    if (!metroOn || !at || !audio) {
      setMetroBeat(null);
      return;
    }
    if (!beatsRef.current.length) computeBeats(songRef.current, songRef.current.sources.find((x) => x.id === sourceId));
    if (!synth) metroRef.current = new RecordingMetronome(metroVolRef.current);
    let shown = -1;
    const timer = window.setInterval(() => {
      const beats = beatsRef.current;
      let idx: number;
      if (synth) {
        idx = beatIndexAt(beats, at.tickPosition, 'tick');
      } else {
        metroRef.current?.tick(beats, audio);
        setMetroSynced(beats.length > 0 && Number.isFinite(beats[0].time));
        idx = audio.paused ? -1 : beatIndexAt(beats, audio.currentTime, 'time');
      }
      if (idx !== shown) {
        shown = idx;
        setMetroBeat(idx >= 0 ? { beat: beats[idx].beat, of: beats[idx].of } : null);
      }
    }, 25);
    return () => {
      window.clearInterval(timer);
      metroRef.current?.close();
      metroRef.current = null;
      if (at) at.metronomeVolume = 0;
    };
  }, [metroOn, sourceId, computeBeats]);

  useEffect(() => {
    metroRef.current?.setVolume(metroVol);
    const at = apiRef.current;
    if (at && metroOn && sourceId === SYNTH_ID) at.metronomeVolume = metroVol;
    try {
      localStorage.setItem(METRO_VOLUME_KEY, String(metroVol));
    } catch {
      /* per-browser convenience only */
    }
  }, [metroVol, metroOn, sourceId]);

  const playPause = useCallback(() => apiRef.current?.playPause(), []);
  const stop = useCallback(() => apiRef.current?.stop(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        playPause();
      } else if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setMetroOn((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playPause]);

  const clearSelection = () => {
    const at = apiRef.current;
    if (!at) return;
    at.playbackRange = null;
    at.clearPlaybackRangeHighlight();
    setHasSelection(false);
  };

  // ------------------------------------------------------------------ sync nudge
  const owner = source ? timelineOwner(song, source) : undefined;
  const nudge = async (delta: number) => {
    if (!owner || !source) return;
    const offset = Math.round(((owner.offset ?? 0) + delta) * 1000) / 1000;
    const s = await api.setSync(song.key, owner.id, { offset });
    songRef.current = s;
    onSongChange(s);
    applySync(s, s.sources.find((x) => x.id === source.id));
  };

  const resync = async () => {
    if (!owner || !source) return;
    const s = await api.setSync(song.key, owner.id, { syncPoints: [], offset: 0 });
    songRef.current = { ...s, sources: s.sources.map((x) => (x.id === owner.id ? { ...x, syncPoints: null } : x)) };
    selectSource(source.id);
  };

  const reseparate = async () => {
    try {
      await runTask('prep:ai-no-guitar', 'Re-running guitar separation…', async (report) => {
        await waitForJob(await api.prepare(song.key, 'ai-no-guitar', true), report);
      });
      await refreshSong();
      if (source?.kind.startsWith('separated')) selectSource(source.id);
    } catch {
      /* shown in task list */
    }
  };

  const resplit = async () => {
    if (!source?.partId) return;
    const at = apiRef.current;
    const part = partsRef.current.find((p) => partIdOf(p) === source.partId);
    if (!part || !at?.score) return;
    try {
      await runTask(`part:${source.partId}`, `Re-splitting “${shortPartName(part)}”…`, async (report) => {
        await waitForJob(await api.splitPart(song.key, source.partId!, splitRequest(at, part, partsRef.current), true), report);
      });
      await refreshSong();
      selectSource(source.id);
    } catch {
      /* shown in task list */
    }
  };

  const chooseCandidate = async (videoId: string) => {
    if (!source) return;
    const s = await api.chooseVideo(song.key, source.id, videoId);
    songRef.current = s;
    onSongChange(s);
    selectSource(source.id);
  };

  // ------------------------------------------------------------------ render
  const pendingTask = pending ? tasks[pending.taskKey] : undefined;
  const pendingSource = pending ? song.sources.find((x) => x.id === pending.id) : undefined;
  const pendingIsNoGuitar =
    !!pending && ((!!pendingSource && ['backing', 'separated'].includes(pendingSource.kind)) || pending.id.startsWith('ai-nopart-'));
  const visibleTasks = Object.values(tasks).filter((t) => t.error || t.key !== pending?.taskKey);
  const isNoGuitar = !!source && source.kind !== 'original' && source.kind !== 'solo' && source.kind !== 'separated-guitar';
  // Songsterr backing/solo videos are only useful when they are about guitar parts.
  const guitarHashes = new Set((song.tracks ?? []).filter((t) => t.kind === 'guitar').map((t) => t.hash));
  const removesGuitar = (s: AudioSource) =>
    s.provider !== 'songsterr' || (s.trackHashes ?? []).some((h) => guitarHashes.has(h));
  const onlyGuitar = (s: AudioSource) =>
    s.provider !== 'songsterr' || (!!s.trackHashes?.length && s.trackHashes.every((h) => guitarHashes.has(h)));
  // EXPERIMENTAL per-part splits: offer them for the part being viewed even before they exist
  const currentPart = parts[trackIdx];
  const virtualPart = (id: string, label: string, kind: AudioSource['kind']): AudioSource =>
    song.sources.find((x) => x.id === id) ?? { id, label, kind, provider: 'demucs', experimental: true, ready: false };
  const partOpts =
    currentPart && original
      ? (() => {
          const ids = partSourceIds(currentPart);
          const name = shortPartName(currentPart);
          return {
            no: virtualPart(ids.no, `No ${name} (AI tab-guided, experimental)`, 'separated'),
            only: virtualPart(ids.only, `Only ${name} (AI tab-guided, experimental)`, 'separated-guitar'),
          };
        })()
      : undefined;
  const isPartSource = (s: AudioSource) => !!s.partId || PART_SOURCE_RE.test(s.id);
  const notPart = (s: AudioSource) => !isPartSource(s);
  const groups: [string, AudioSource[]][] = [
    ['Full song', song.sources.filter((s) => s.kind === 'original')],
    ['Backing tracks (guitar removed)', song.sources.filter((s) => (s.kind === 'backing' && removesGuitar(s)) || (s.kind === 'separated' && notPart(s)))],
    ['Isolated guitar', song.sources.filter((s) => (s.kind === 'solo' && onlyGuitar(s)) || (s.kind === 'separated-guitar' && notPart(s)))],
    ['Experimental: this part only (AI tab-guided)', partOpts ? [partOpts.no, partOpts.only] : []],
  ];

  return (
    <div className="player">
      <header className="player-head">
        <button className="ghost" onClick={onBack} title="Back to search">
          ← Back
        </button>
        <div className="song-title">
          <h1>{song.title}</h1>
          <span>{song.artist}</span>
        </div>
        <div className="mode-toggle" role="group" aria-label="Audio">
          <button
            className={pending?.id === 'original' ? 'pending' : !isNoGuitar && sourceId !== SYNTH_ID ? 'on' : ''}
            onClick={() => original && selectSource('original')}
            disabled={!original}
            title="Play the original recording"
          >
            Original
          </button>
          <button
            className={pending && pendingIsNoGuitar ? 'pending' : isNoGuitar ? 'on' : ''}
            onClick={() => noGuitar && selectSource(noGuitar.id)}
            disabled={!noGuitar || (noGuitar.kind === 'separated' && !original)}
            title={noGuitar ? `Play: ${noGuitar.label}` : 'No backing available'}
          >
            No guitar
            {pending && pendingIsNoGuitar && <span className="spinner" aria-hidden />}
          </button>
        </div>
      </header>

      <div className="toolbar">
        <div className="transport">
          <button className="play" onClick={playPause} title="Play / pause (space)">
            {playing ? '❚❚' : '►'}
          </button>
          <button className="ghost" onClick={stop} title="Back to start">
            ■
          </button>
          <span className="time">
            {fmtTime(time.cur)} / {fmtTime(time.dur)}
          </span>
        </div>

        <label className="field">
          <span>Part</span>
          <select value={trackIdx} onChange={(e) => setTrackIdx(+e.target.value)}>
            {parts.map((p, i) => (
              <option key={i} value={i}>
                {p.name}
                {p.track?.difficulty ? ` · difficulty ${p.track.difficulty}` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Audio</span>
          <select value={pending?.id ?? sourceId} onChange={(e) => selectSource(e.target.value)}>
            {groups.map(([label, list]) =>
              list.length ? (
                <optgroup key={label} label={label}>
                  {list.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                      {s.ready ? '' : ' ⤓'}
                    </option>
                  ))}
                </optgroup>
              ) : null,
            )}
            <optgroup label="Other">
              <option value={SYNTH_ID}>Tab synth (MIDI)</option>
            </optgroup>
          </select>
        </label>

        <label className="field speed">
          <span>Speed {Math.round(speed * 100)}%</span>
          <input type="range" min={0.4} max={1.25} step={0.05} value={speed} onChange={(e) => setSpeed(+e.target.value)} />
        </label>

        <label className="field speed">
          <span>Volume {Math.round(volume * 100)}%</span>
          <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(+e.target.value)} />
        </label>

        <div className="field metronome">
          <span>Metronome</span>
          <div className="row">
            <button
              className={metroOn ? 'chip on' : 'chip'}
              onClick={() => setMetroOn((v) => !v)}
              aria-pressed={metroOn}
              title="Click along with the song's beat, following the recording's tempo (M)"
            >
              {metroOn ? 'On' : 'Off'}
            </button>
            {metroOn && (
              <>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={metroVol}
                  onChange={(e) => setMetroVol(+e.target.value)}
                  aria-label="Metronome volume"
                  title={`Metronome volume ${Math.round(metroVol * 100)}%`}
                />
                {!metroSynced && sourceId !== SYNTH_ID ? (
                  <span className="muted metro-note">waiting for sync…</span>
                ) : (
                  <span className="beat-dots" aria-hidden>
                    {Array.from({ length: metroBeat?.of ?? 4 }, (_, i) => (
                      <i key={i} className={(metroBeat?.beat === i + 1 ? 'lit' : '') + (i === 0 ? ' down' : '')} />
                    ))}
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        <div className="field">
          <span>Loop</span>
          <div className="row">
            <button className={looping ? 'chip on' : 'chip'} onClick={() => setLooping((v) => !v)} title="Loop the selected bars (drag over the tab to select)">
              ⟲ {hasSelection ? 'selection' : 'song'}
            </button>
            {hasSelection && (
              <button className="chip" onClick={clearSelection} title="Clear selection">
                ✕
              </button>
            )}
          </div>
        </div>

        <div className="field">
          <span>View</span>
          <div className="row">
            <button className={tabOnly ? 'chip on' : 'chip'} onClick={() => setTabOnly((v) => !v)} title="Hide standard notation">
              Tab only
            </button>
            <button className={horizontal ? 'chip on' : 'chip'} onClick={() => setHorizontal((v) => !v)} title="Single horizontal line">
              ⟷
            </button>
            <button className="chip" onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.1).toFixed(2)))}>
              −
            </button>
            <button className="chip" onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))}>
              +
            </button>
          </div>
        </div>
      </div>

      {pending && (
        <div className="pending-bar" role="status">
          <span className="spinner" aria-hidden />
          <div className="pending-text">
            <b>Preparing “{pending.label}”</b>
            <span>
              {pendingTask?.message ?? 'Starting…'} · still playing{' '}
              {sourceId === SYNTH_ID ? 'the tab synth' : source ? `“${source.label}”` : 'nothing yet'} until it's ready
            </span>
          </div>
          <div className="bar">
            <div style={{ width: `${Math.round((pendingTask?.progress ?? 0) * 100)}%` }} />
          </div>
          <b className="pct">{Math.round((pendingTask?.progress ?? 0) * 100)}%</b>
          <button className="chip" onClick={cancelPending} title="Keep the current audio (the work continues in the background and is saved)">
            Cancel
          </button>
        </div>
      )}

      {source && sourceId !== SYNTH_ID && (
        <div className="subbar">
          <span className="muted">
            {source.provider === 'songsterr' && 'Synced by Songsterr'}
            {source.provider === 'youtube' && `YouTube: ${source.videoTitle ?? source.videoId}`}
            {source.provider === 'demucs' &&
              (source.experimental
                ? 'Experimental: one guitar part split out using the tab. Expect artifacts where guitars play the same notes'
                : 'AI-separated from the original recording')}
            {owner?.syncMethod === 'auto' && ' · auto-synced'}
          </span>
          <span className="nudge">
            Sync offset
            <button className="chip" onClick={() => nudge(-0.05)} title="Cursor 50 ms earlier">
              −50ms
            </button>
            <b>{((owner?.offset ?? 0) * 1000).toFixed(0)} ms</b>
            <button className="chip" onClick={() => nudge(0.05)} title="Cursor 50 ms later">
              +50ms
            </button>
            {owner?.provider === 'youtube' && (
              <button className="chip" onClick={resync} title="Run automatic alignment again">
                Re-sync
              </button>
            )}
          </span>
          {source.provider === 'youtube' && (source.candidates?.length ?? 0) > 1 && (
            <label className="field inline">
              <span>Wrong video?</span>
              <select value={source.videoId} onChange={(e) => chooseCandidate(e.target.value)}>
                {source.candidates!.map((c) => (
                  <option key={c.videoId} value={c.videoId}>
                    {c.title} {c.duration ? `(${fmtTime(c.duration)})` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {source.provider === 'demucs' && (
            <button className="chip" onClick={reseparate} title="Run the AI separation again (also redoes part splits)">
              Re-separate
            </button>
          )}
          {source.experimental && (
            <button className="chip" onClick={resplit} title="Split this part again (e.g. after fixing the sync offset)">
              Re-split part
            </button>
          )}
        </div>
      )}

      {(visibleTasks.length > 0 || error) && (
        <div className="tasks">
          {visibleTasks.map((t) => (
            <div key={t.key} className={t.error ? 'task error' : 'task'}>
              <span>{t.error ? `${t.message} — ${t.error}` : t.message}</span>
              {!t.error && (
                <div className="bar">
                  <div style={{ width: `${Math.round(t.progress * 100)}%` }} />
                </div>
              )}
              {t.error && (
                <button
                  className="chip"
                  onClick={() =>
                    setTasks((all) => {
                      const { [t.key]: _, ...rest } = all;
                      return rest;
                    })
                  }
                >
                  dismiss
                </button>
              )}
            </div>
          ))}
          {error && <div className="task error">{error}</div>}
        </div>
      )}

      <div className="viewport" ref={viewportRef}>
        {rendering && <div className="loading">Rendering tab…</div>}
        <div className="sheet">
          <div ref={hostRef} />
        </div>
      </div>
      <audio ref={audioRef} preload="auto" hidden />
    </div>
  );
}
