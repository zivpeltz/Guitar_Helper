// Helpers bridging our audio sources / sync points with alphaTab.
import * as alphaTab from '@coderline/alphatab';
import type { AudioSource, Song, SongTrack } from '../api';

/** The source whose timeline (sync points + offset) applies to `src` (separated audio reuses the original's). */
export function timelineOwner(song: Song, src: AudioSource): AudioSource {
  if (src.syncFrom) return song.sources.find((s) => s.id === src.syncFrom) ?? src;
  return src;
}

export function toFlatSyncPoints(song: Song, src: AudioSource, barCount: number): alphaTab.model.FlatSyncPoint[] {
  const owner = timelineOwner(song, src);
  const pts = owner.syncPoints ?? [];
  const offset = owner.offset ?? 0;
  return pts
    .filter((p) => p.barIndex < barCount)
    .map((p) => ({
      barIndex: p.barIndex,
      barOccurence: p.occurrence,
      barPosition: 0,
      millisecondOffset: Math.max(0, (p.seconds + offset) * 1000),
    }));
}

export function hasSync(song: Song, src: AudioSource): boolean {
  return !!timelineOwner(song, src).syncPoints?.length;
}

/** Render the score to MIDI and list where each bar (occurrence) starts, for server-side auto alignment. */
export function exportMidiForAlignment(score: alphaTab.model.Score, settings: alphaTab.Settings) {
  const midi = new alphaTab.midi.MidiFile();
  const handler = new alphaTab.midi.AlphaSynthMidiFileHandler(midi, true);
  const gen = new alphaTab.midi.MidiFileGenerator(score, settings, handler);
  gen.generate();
  const occurrences = new Map<number, number>();
  const bars = gen.tickLookup.masterBars.map((mb) => {
    const idx = mb.masterBar.index;
    const occurrence = occurrences.get(idx) ?? 0;
    occurrences.set(idx, occurrence + 1);
    return { barIndex: idx, occurrence, tick: mb.start };
  });
  const bin = midi.toBinary();
  let s = '';
  for (let i = 0; i < bin.length; i += 0x8000) s += String.fromCharCode(...bin.subarray(i, i + 0x8000));
  return { midiBase64: btoa(s), bars };
}

/**
 * Pick the best "no guitar" audio for the selected guitar part:
 * a Songsterr backing that removes this part (preferring ones that remove only guitars),
 * then a YouTube backing track, then AI separation.
 */
export function bestNoGuitarSource(song: Song, track: SongTrack | undefined): AudioSource | undefined {
  const backings = song.sources.filter((s) => s.kind === 'backing');
  const removesPart = (s: AudioSource) => !!track && (s.trackHashes ?? []).includes(track.hash);
  const ranked = [...backings].sort((a, b) => score(b) - score(a));
  function score(s: AudioSource) {
    let v = 0;
    if (removesPart(s)) v += 10;
    if (s.guitarOnlyRemoved) v += 3;
    if (s.provider === 'youtube') v += 1;
    v -= (s.trackHashes?.length ?? 0) * 0.1; // fewer removed tracks = closer to the real song
    return v;
  }
  const best = ranked[0];
  if (best && (removesPart(best) || best.provider === 'youtube' || (!track && best.guitarOnlyRemoved))) return best;
  return song.sources.find((s) => s.id === 'ai-no-guitar') ?? best;
}

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
