// Metronome that follows the *recording*, not a fixed tempo.
//
// Beats come from the tab's time signatures (in playback order, repeats expanded); each
// beat is placed in the recording through the same bar sync points the cursor uses, so
// clicks follow the band's real tempo drift. Clicks are scheduled slightly ahead on a
// Web Audio clock (the standard "lookahead scheduler"), which keeps them tight.
import * as alphaTab from '@coderline/alphatab';
import type { SyncPoint } from '../api';

export interface Beat {
  tick: number;
  /** Seconds in the recording, or NaN when there's no sync for it. */
  time: number;
  /** 1-based position in the bar; 1 = downbeat */
  beat: number;
  of: number;
}

interface PlaybackBar {
  barIndex: number;
  occurrence: number;
  start: number;
  end: number;
  num: number;
  den: number;
}

const QUARTER = 960; // alphaTab MIDI ticks per quarter note

/** Bars in playback order (repeats/endings expanded), with their tick ranges and time signatures. */
export function playbackBars(score: alphaTab.model.Score, settings: alphaTab.Settings): PlaybackBar[] {
  const midi = new alphaTab.midi.MidiFile();
  const gen = new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(midi, true));
  gen.generate();
  const seen = new Map<number, number>();
  return gen.tickLookup.masterBars.map((mb) => {
    const idx = mb.masterBar.index;
    const occurrence = seen.get(idx) ?? 0;
    seen.set(idx, occurrence + 1);
    return {
      barIndex: idx,
      occurrence,
      start: mb.start,
      end: mb.end,
      num: mb.masterBar.timeSignatureNumerator,
      den: mb.masterBar.timeSignatureDenominator,
    };
  });
}

/** One click per beat. Compound meters (6/8, 9/8, 12/8) click on the dotted quarter, like most players count them. */
export function beatsFor(bars: PlaybackBar[]): Omit<Beat, 'time'>[] {
  const out: Omit<Beat, 'time'>[] = [];
  for (const b of bars) {
    const compound = b.den === 8 && b.num > 3 && b.num % 3 === 0;
    const step = compound ? (3 * QUARTER * 4) / 8 : (QUARTER * 4) / b.den;
    const of = compound ? b.num / 3 : b.num;
    for (let i = 0, t = b.start; t < b.end - 1 && i < 64; i++, t += step) {
      out.push({ tick: t, beat: (i % of) + 1, of });
    }
  }
  return out;
}

/** Piecewise-linear tick → seconds through the bar sync points (extrapolated at both ends). */
export function tickToSeconds(bars: PlaybackBar[], points: SyncPoint[], offset: number): ((tick: number) => number) | null {
  const byKey = new Map(points.map((p) => [`${p.barIndex}:${p.occurrence}`, p.seconds]));
  const ticks: number[] = [];
  const secs: number[] = [];
  for (const b of bars) {
    const s = byKey.get(`${b.barIndex}:${b.occurrence}`);
    if (s === undefined) continue;
    if (ticks.length && (b.start <= ticks[ticks.length - 1] || s < secs[secs.length - 1])) continue;
    ticks.push(b.start);
    secs.push(s + offset);
  }
  if (ticks.length < 2) return null;
  const n = ticks.length;
  return (tick: number) => {
    let i: number;
    if (tick <= ticks[0]) i = 0;
    else if (tick >= ticks[n - 1]) i = n - 2;
    else {
      let lo = 0;
      let hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ticks[mid] <= tick) lo = mid;
        else hi = mid;
      }
      i = lo;
    }
    return secs[i] + ((tick - ticks[i]) * (secs[i + 1] - secs[i])) / (ticks[i + 1] - ticks[i]);
  };
}

/** Index of the last beat at or before `value` (by `key`), or -1. */
export function beatIndexAt(beats: Beat[], value: number, key: 'time' | 'tick'): number {
  let lo = 0;
  let hi = beats.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid][key] <= value) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const LOOKAHEAD = 0.15; // s of recording time scheduled ahead

/** Schedules clicks against an <audio> element that's playing the recording. */
export class RecordingMetronome {
  private ctx = new AudioContext({ latencyHint: 'interactive' });
  private out = this.ctx.createGain();
  private pending: { node: AudioScheduledSourceNode; at: number }[] = [];
  private next = 0; // index of the next beat to schedule
  /**
   * ctx time = offset + recording time / rate. `audio.currentTime` is coarse (Firefox updates it in
   * ~10–40 ms steps), so the offset is smoothed; using raw readings makes the clicks audibly uneven.
   */
  private clock: { offset: number; rate: number } | null = null;

  constructor(volume: number) {
    this.out.gain.value = volume;
    this.out.connect(this.ctx.destination);
  }

  setVolume(v: number) {
    this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  /** Call every ~25 ms. */
  tick(beats: Beat[], audio: HTMLAudioElement) {
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    const now = this.ctx.currentTime;
    const t = audio.currentTime;
    const rate = audio.playbackRate || 1;
    if (audio.paused || !beats.length) {
      this.reset();
      return;
    }
    const measured = now - t / rate;
    // a seek / loop jump / speed change: drop what's queued and resync
    if (!this.clock || this.clock.rate !== rate || Math.abs(measured - this.clock.offset) > 0.12) {
      this.cancel();
      this.clock = { offset: measured, rate };
      this.next = Math.max(0, beatIndexAt(beats, t - 0.005, 'time') + 1);
    } else {
      this.clock.offset += 0.05 * (measured - this.clock.offset);
    }
    const offset = this.clock.offset;
    while (this.next < beats.length) {
      const b = beats[this.next];
      if (!Number.isFinite(b.time)) {
        this.next++;
        continue;
      }
      if (b.time > t + LOOKAHEAD * rate) break;
      const when = offset + b.time / rate;
      if (when >= now - 0.005) this.click(Math.max(now, when), b.beat === 1);
      this.next++;
    }
    this.pending = this.pending.filter((p) => p.at > now - 0.1);
  }

  /** A click: short pitched blip, higher and louder on the downbeat. */
  click(when: number, accent: boolean) {
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.frequency.value = accent ? 1760 : 1175;
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(accent ? 1 : 0.6, when + 0.002);
    env.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    osc.connect(env).connect(this.out);
    osc.start(when);
    osc.stop(when + 0.06);
    this.pending.push({ node: osc, at: when });
  }

  private cancel() {
    for (const p of this.pending) {
      try {
        p.node.stop();
      } catch {
        /* already stopped */
      }
    }
    this.pending = [];
  }

  reset() {
    this.cancel();
    this.clock = null;
  }

  close() {
    this.cancel();
    void this.ctx.close();
  }
}
