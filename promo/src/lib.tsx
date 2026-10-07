import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';

export const FPS = 60;
export const W = 1920;
export const H = 1080;

// The track (music5.mp3): 116.98 bpm, first beat at 0.065s (measured from the audio).
const BEAT_S = 0.51291;
const FIRST_S = 0.065;
/** Frame of beat n (fractions allowed). */
export const B = (n: number): number => Math.round((FIRST_S + n * BEAT_S) * FPS);
export const BEAT_F = BEAT_S * FPS;

export const C = {
  bg: '#14120D',
  surface: '#1D1A13',
  line: '#3A3427',
  text: '#FBF6EA',
  muted: '#B3AA96',
  accent: '#FEC800',
};

export const FONT = '"Instrument Sans", -apple-system, sans-serif';
export const SERIF = '"Instrument Serif", Georgia, serif';

/** One easing family for the whole film. */
export const EASE = {
  out: Easing.bezier(0.16, 1, 0.3, 1), // arrivals: fast start, long gentle landing
  inOut: Easing.bezier(0.65, 0, 0.35, 1), // camera and travel
  in: Easing.bezier(0.55, 0, 1, 0.45), // exits
  std: Easing.bezier(0.2, 0, 0, 1),
  land: Easing.bezier(0.2, 0, 0, 1), // heavy things (window, cards, chip) land rather than pop
};

export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** 0→1 between frames a and b with an easing. */
export const prog = (f: number, a: number, b: number, ease = EASE.out): number =>
  interpolate(f, [a, b], [0, 1], { ...clamp, easing: ease });

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export type Rect = { x: number; y: number; w: number; h: number };

// ─── Text ──────────────────────────────────────────────────────────────────
/** Text sizes: headlines, captions, taglines. */
export const HERO = 112;
export const CAP = 68;
export const SUB = 52;
/** One rhythm for every line in the film: a word on every eighth note of
 *  the track (0.256s), each rising in over WORD_IN; once the last word has
 *  settled a line holds for reading time only, READ(words) frames (0.3s for
 *  three words, a little more for longer lines), then leaves in LINE_OUT.
 *  Demo captions instead leave when their action is done (outAt). */
export const WORD_GAP = BEAT_F / 2;
export const WORD_IN = 28;
export const READ = (words: number): number => 18 + 3 * Math.max(0, words - 3);
export const LINE_OUT = 12;

/** Frame word k of a line starting at `at` begins to rise. */
export const wordAt = (at: number, k: number): number => Math.round(at + k * WORD_GAP);
/** Tokens of a line: a word with its punctuation (a lone "/" breaks the line). */
export const wordsOf = (text: string) => text.split(' ').filter((w) => w !== '/');
/** Frame the last word of a line starting at `at` has settled. */
export const lineSettled = (text: string, at: number): number => wordAt(at, wordsOf(text).length - 1) + WORD_IN;
/** Frame a line starting at `at` begins to leave. */
export const lineOut = (text: string, at: number): number => lineSettled(text, at) + READ(wordsOf(text).length);
/** Frame a line starting at `at` is gone. */
export const lineGone = (text: string, at: number): number => lineOut(text, at) + LINE_OUT;

type WordsProps = {
  /** Words separated by spaces; a lone "/" breaks the line. */
  text: string;
  at: number;
  /** Stays up (no exit), e.g. the end card. */
  hold?: boolean;
  /** A later exit than the rhythm's, for a line that frames what lands under it. */
  outAt?: number;
  size?: number;
  weight?: number;
  color?: string;
  accent?: string[]; // set in the serif italic (the highlight)
  style?: React.CSSProperties;
};

/** A line that arrives word by word (rise + fade, no blur, no mask, so the
 *  serif highlight shares the sans baseline) and leaves as one piece after
 *  the film's fixed reading time. */
export const Words: React.FC<WordsProps> = ({ text, at, hold, outAt, size = CAP, weight = 600, color = C.text, accent = [], style }) => {
  const f = useCurrentFrame();
  const out = hold ? Infinity : outAt ?? lineOut(text, at);
  if (f < at - 1 || f > out + LINE_OUT) return null;
  const exit = hold ? 0 : prog(f, out, out + LINE_OUT, EASE.in);
  const lines: string[][] = [[]];
  for (const w of text.split(' ')) {
    if (w === '/') lines.push([]);
    else lines[lines.length - 1].push(w);
  }
  let i = 0;
  return (
    <div style={{ fontFamily: FONT, fontWeight: weight, fontSize: size, letterSpacing: '-0.03em', lineHeight: 1.12, color, textAlign: 'center', whiteSpace: 'nowrap', opacity: 1 - exit, transform: `translateY(${-exit * size * 0.12}px)`, ...style }}>
      {lines.map((line, li) => (
        <div key={li}>
          {line.map((w, wi) => {
            const k = i++;
            const w0 = wordAt(at, k);
            const t = prog(f, w0, w0 + WORD_IN, EASE.out);
            const hi = accent.includes(w.replace(/[.,!?]/g, ''));
            return (
              <React.Fragment key={wi}>
                {wi > 0 ? ' ' : null}
                <span style={{
                  display: 'inline-block', opacity: t, transform: `translateY(${(1 - t) * 0.32}em)`,
                  ...(hi ? { fontFamily: SERIF, fontStyle: 'italic', fontWeight: 400, fontSize: '1.06em', letterSpacing: '-0.005em' } : null),
                }}>{w}</span>
              </React.Fragment>
            );
          })}
        </div>
      ))}
    </div>
  );
};

// ─── Cursor ────────────────────────────────────────────────────────────────
export const Cursor: React.FC<{ x: number; y: number; press?: number; opacity?: number; pencil?: boolean; scale?: number }> = ({
  x, y, press = 0, opacity = 1, pencil = false, scale = 1,
}) => (
  <div style={{ position: 'absolute', left: x, top: y, opacity, transform: `scale(${scale * (1 - press * 0.16)})`, transformOrigin: '0 0', pointerEvents: 'none', filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.35))' }}>
    {pencil ? (
      <svg width="34" height="34" viewBox="0 0 24 24" style={{ transform: 'translate(-2px, -32px)' }}>
        <path d="M3 21l3.5-1 11-11-2.5-2.5-11 11L3 21z" fill="#FBF6EA" stroke="#14120D" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M15 6.5l2.5 2.5 1.8-1.8a1.2 1.2 0 000-1.7l-.8-.8a1.2 1.2 0 00-1.7 0L15 6.5z" fill="#FEC800" stroke="#14120D" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    ) : (
      <svg width="28" height="37" viewBox="0 0 15 20">
        <path d="M1 1v15.2l3.6-3.4 2.4 5.6 2.6-1.1-2.4-5.5H12L1 1z" fill="#111" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    )}
  </div>
);
