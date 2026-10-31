/**
 * Converts Songsterr's per-track JSON into an alphaTab Score so alphaTab can render
 * proper notation + tablature and drive the playback cursor.
 *
 * Songsterr string indices are 0 = highest string; alphaTab uses 1 = lowest string.
 */
import * as alphaTab from '@coderline/alphatab';

const m = alphaTab.model;

export interface SongsterrNote {
  fret?: number;
  string?: number;
  rest?: boolean;
  tie?: boolean;
  dead?: boolean;
  ghost?: boolean;
  hp?: boolean;
  staccato?: boolean;
  accentuated?: number;
  leftHandVibrato?: string;
  harmonic?: string;
  harmonicFret?: number;
  slide?: string;
  bend?: { tone: number; points: { position: number; tone: number }[] };
}

export interface SongsterrBeat {
  notes?: SongsterrNote[];
  rest?: boolean;
  duration: [number, number];
  dots?: number;
  tuplet?: number;
  velocity?: string;
  text?: { text: string };
  chord?: { text: string };
  palmMute?: boolean;
  letRing?: boolean;
  graceNote?: string;
  pickStroke?: string;
  tremoloBar?: { points: { position: number; tone: number }[] };
  brushStroke?: { direction: string };
  slapping?: boolean;
  vibratoWithTremoloBar?: string;
}

export interface SongsterrMeasure {
  voices?: { beats: SongsterrBeat[] }[];
  signature?: [number, number];
  marker?: { text: string };
  rest?: boolean;
  doubleBarline?: boolean;
  keySignature?: { accidentalCount: number; mode?: string; transposeAs?: string };
  repeatStart?: boolean;
  repeatClose?: number | { count?: number } | boolean;
  alternateEnding?: number[];
}

export interface SongsterrTrack {
  name?: string;
  instrumentId?: number;
  strings?: number;
  tuning?: number[];
  capo?: number;
  measures?: SongsterrMeasure[];
  automations?: { tempo?: { measure: number; position: number; bpm: number }[] };
}

export interface TrackInfo {
  index: number;
  name: string;
  kind: string;
}

const SLIDE_OUT: Record<string, alphaTab.model.SlideOutType> = {
  shift: m.SlideOutType.Shift,
  legato: m.SlideOutType.Legato,
  downwards: m.SlideOutType.OutDown,
  upwards: m.SlideOutType.OutUp,
};
const SLIDE_IN: Record<string, alphaTab.model.SlideInType> = {
  below: m.SlideInType.IntoFromBelow,
  above: m.SlideInType.IntoFromAbove,
};
const HARMONIC: Record<string, alphaTab.model.HarmonicType> = {
  natural: m.HarmonicType.Natural,
  artificial: m.HarmonicType.Artificial,
  pinch: m.HarmonicType.Pinch,
  tap: m.HarmonicType.Tap,
  semi: m.HarmonicType.Semi,
  feedback: m.HarmonicType.Feedback,
};

function shortName(name: string): string {
  const parts = name.split('|').map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : name;
}

function toDuration(den: number): alphaTab.model.Duration {
  const allowed = [1, 2, 4, 8, 16, 32, 64, 128];
  const d = allowed.includes(den) ? den : 4;
  return d as alphaTab.model.Duration;
}

function tupletDenominator(n: number): number {
  // common tuplets: 3:2, 5:4, 6:4, 7:4, 9:8 ...
  if (n === 3) return 2;
  if (n === 6 || n === 5 || n === 7) return 4;
  if (n === 9 || n === 10 || n === 11 || n === 12 || n === 13) return 8;
  if (n === 2) return 3;
  return Math.pow(2, Math.floor(Math.log2(n)));
}

function isRestOnlyVoice(v: { beats: SongsterrBeat[] }): boolean {
  return v.beats.every((b) => b.rest || !(b.notes || []).some((n) => !n.rest));
}

/**
 * Build a Score. `tracks` lists which Songsterr tracks to include (in display order) and
 * `data[i]` is the JSON of track `tracks[i]`.
 */
export function songsterrToScore(
  title: string,
  artist: string,
  tracks: TrackInfo[],
  data: SongsterrTrack[],
  settings: alphaTab.Settings,
): alphaTab.model.Score {
  const score = new m.Score();
  score.title = title;
  score.artist = artist;

  const measureCount = Math.max(0, ...data.map((d) => d.measures?.length ?? 0));
  const ref = data.reduce((a, b) => ((b.measures?.length ?? 0) > (a.measures?.length ?? 0) ? b : a), data[0]);
  const tempos = [...(data.find((d) => d.automations?.tempo?.length)?.automations?.tempo ?? [])];
  if (!tempos.some((t) => t.measure === 0)) tempos.unshift({ measure: 0, position: 0, bpm: tempos[0]?.bpm ?? 120 });

  // ---- master bars (shared timeline: signatures, sections, tempo, repeats)
  let num = 4;
  let den = 4;
  let key = { sig: m.KeySignature.C, type: m.KeySignatureType.Major };
  const keys: (typeof key)[] = [];
  for (let i = 0; i < measureCount; i++) {
    const rm: SongsterrMeasure = ref.measures?.[i] ?? {};
    const mb = new m.MasterBar();
    if (rm.signature) [num, den] = rm.signature;
    mb.timeSignatureNumerator = num;
    mb.timeSignatureDenominator = den;
    if (rm.marker?.text) {
      const s = new m.Section();
      s.text = rm.marker.text.replace(/\s*-\s*\d+:\d+\s*$/, ''); // "Intro - 0:00" -> "Intro"
      s.marker = '';
      mb.section = s;
    }
    if (rm.doubleBarline) mb.isDoubleBar = true;
    if (rm.keySignature) {
      const c = rm.keySignature.accidentalCount || 0;
      key = {
        sig: (rm.keySignature.transposeAs === 'b' ? -Math.abs(c) : c) as alphaTab.model.KeySignature,
        type: rm.keySignature.mode === 'minor' ? m.KeySignatureType.Minor : m.KeySignatureType.Major,
      };
    }
    keys.push(key);
    if (rm.repeatStart) mb.isRepeatStart = true;
    if (rm.repeatClose) {
      const rc = rm.repeatClose;
      mb.repeatCount = typeof rc === 'number' ? rc : typeof rc === 'object' && rc.count ? rc.count : 2;
    }
    if (rm.alternateEnding?.length) {
      mb.alternateEndings = rm.alternateEnding.reduce((acc, e) => acc | (1 << (e - 1)), 0);
    }
    for (const t of tempos.filter((t) => t.measure === i)) {
      mb.tempoAutomations.push(m.Automation.buildTempoAutomation(false, 0, t.bpm, 2));
    }
    score.addMasterBar(mb);
  }

  // ---- tracks
  tracks.forEach((info, ti) => {
    const d = data[ti];
    const track = new m.Track();
    track.name = shortName(info.name);
    track.shortName = track.name.slice(0, 10);
    track.ensureStaveCount(1);
    const pi = track.playbackInfo;
    pi.program = d.instrumentId !== undefined && d.instrumentId < 128 ? d.instrumentId : 25;
    // unique channels per track, skipping the GM drum channel 9
    const ch = (n: number) => (n >= 9 ? n + 1 : n);
    pi.primaryChannel = ch((ti * 2) % 15);
    pi.secondaryChannel = ch((ti * 2 + 1) % 15);

    const staff = track.staves[0];
    const strings = d.strings ?? d.tuning?.length ?? 6;
    const tuning = d.tuning?.length ? d.tuning : (m.Tuning.getDefaultTuningFor(strings)?.tunings ?? [64, 59, 55, 50, 45, 40]);
    staff.stringTuning = new m.Tuning('', tuning, false);
    staff.capo = d.capo ?? 0;
    staff.showTablature = true;
    staff.showStandardNotation = true;
    const isBass = info.kind === 'bass';

    const chordIds = new Map<string, string>();
    // drop voices that are only rests in the whole track (Songsterr pads 2nd voices with rests)
    const maxVoices = Math.max(1, ...(d.measures ?? []).map((ms) => ms.voices?.length ?? 0));
    const keepVoice = Array.from({ length: maxVoices }, (_, vi) =>
      vi === 0 || (d.measures ?? []).some((ms) => ms.voices?.[vi] && !isRestOnlyVoice(ms.voices[vi])),
    );
    const voiceCount = keepVoice.lastIndexOf(true) + 1;

    for (let i = 0; i < measureCount; i++) {
      const sm: SongsterrMeasure = d.measures?.[i] ?? {};
      const bar = new m.Bar();
      bar.clef = isBass ? m.Clef.F4 : m.Clef.G2;
      bar.clefOttava = m.Ottavia._8vb;
      bar.keySignature = keys[i].sig;
      bar.keySignatureType = keys[i].type;
      staff.addBar(bar);

      // alphaTab requires the same voice count in every bar of a staff
      const voices = Array.from({ length: voiceCount }, (_, vi) => (vi < (sm.voices?.length ?? 0) && keepVoice[vi] ? sm.voices![vi] : { beats: [] }));
      for (const sv of voices) {
        const voice = new m.Voice();
        bar.addVoice(voice);
        if (!sv.beats.length) {
          const b = new m.Beat();
          b.isEmpty = true;
          b.duration = m.Duration.Whole;
          voice.addBeat(b);
          continue;
        }
        for (const sb of sv.beats) {
          voice.addBeat(convertBeat(sb, strings, staff, chordIds));
        }
      }
    }
    score.addTrack(track);
  });

  score.finish(settings);
  return score;
}

function convertBeat(
  sb: SongsterrBeat,
  strings: number,
  staff: alphaTab.model.Staff,
  chordIds: Map<string, string>,
): alphaTab.model.Beat {
  const beat = new m.Beat();
  beat.duration = toDuration(sb.duration?.[1] ?? 4);
  beat.dots = sb.dots ?? 0;
  if (sb.tuplet && sb.tuplet > 1) {
    beat.tupletNumerator = sb.tuplet;
    beat.tupletDenominator = tupletDenominator(sb.tuplet);
  }
  if (sb.text?.text) beat.text = sb.text.text;
  if (sb.chord?.text) {
    let id = chordIds.get(sb.chord.text);
    if (!id) {
      id = `c${chordIds.size}`;
      chordIds.set(sb.chord.text, id);
      const chord = new m.Chord();
      chord.name = sb.chord.text;
      chord.showDiagram = false;
      chord.showName = true;
      staff.addChord(id, chord);
    }
    beat.chordId = id;
  }
  if (sb.graceNote) beat.graceType = sb.graceNote === 'onBeat' ? m.GraceType.OnBeat : m.GraceType.BeforeBeat;
  if (sb.pickStroke) beat.pickStroke = sb.pickStroke === 'up' ? m.PickStroke.Up : m.PickStroke.Down;
  if (sb.brushStroke) beat.brushType = sb.brushStroke.direction === 'up' ? m.BrushType.BrushUp : m.BrushType.BrushDown;
  if (sb.slapping) beat.slap = true;
  if (sb.velocity) {
    const dyn = (m.DynamicValue as unknown as Record<string, number>)[sb.velocity.toUpperCase()];
    if (dyn !== undefined) beat.dynamics = dyn as alphaTab.model.DynamicValue;
  }
  if (sb.tremoloBar?.points?.length) {
    for (const p of sb.tremoloBar.points) beat.addWhammyBarPoint(new m.BendPoint(p.position, Math.round(p.tone / 25)));
  }

  if (!sb.rest) {
    for (const sn of sb.notes ?? []) {
      if (sn.rest || sn.fret === undefined || sn.string === undefined) continue;
      const note = new m.Note();
      note.string = strings - sn.string;
      note.fret = sn.fret;
      if (sn.tie) note.isTieDestination = true;
      if (sn.dead) note.isDead = true;
      if (sn.ghost) note.isGhost = true;
      if (sn.hp) note.isHammerPullOrigin = true;
      if (sn.staccato) note.isStaccato = true;
      if (sn.accentuated) note.accentuated = sn.accentuated >= 2 ? m.AccentuationType.Heavy : m.AccentuationType.Normal;
      if (sn.leftHandVibrato) note.vibrato = sn.leftHandVibrato === 'wide' ? m.VibratoType.Wide : m.VibratoType.Slight;
      if (sn.harmonic && HARMONIC[sn.harmonic]) {
        note.harmonicType = HARMONIC[sn.harmonic];
        if (sn.harmonicFret) note.harmonicValue = sn.harmonicFret;
      }
      if (sn.slide) {
        if (SLIDE_OUT[sn.slide] !== undefined) note.slideOutType = SLIDE_OUT[sn.slide];
        else if (SLIDE_IN[sn.slide] !== undefined) note.slideInType = SLIDE_IN[sn.slide];
      }
      if (sn.bend?.points?.length) {
        for (const p of sn.bend.points) note.addBendPoint(new m.BendPoint(p.position, Math.round(p.tone / 25)));
      }
      if (sb.palmMute) note.isPalmMute = true;
      if (sb.letRing) note.isLetRing = true;
      beat.addNote(note);
    }
  }
  return beat;
}
