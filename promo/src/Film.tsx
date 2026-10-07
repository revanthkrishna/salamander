import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AbsoluteFill, Audio, continueRender, delayRender, Img, interpolateColors, staticFile, useCurrentFrame } from 'remotion';
import takes from '../public/take/takes.json';
import { B, BEAT_F, C, CAP, Cursor, EASE, FONT, FPS, H, HERO, lerp, lineGone, lineOut, LINE_OUT, prog, Rect, SERIF, SUB, W, WORD_IN, wordAt, Words } from './lib';

// 39.07s: the whole track (music5.mp3), untouched.
export const DURATION = 2344;

type LogEntry = { t: number; x: number; y: number; kind: string; pencil?: boolean; virtual?: boolean };
type Take = { filmStart: number; speed: number; duration: number; frames: number[]; log: LogEntry[] };
const DATA = takes as unknown as { takes: Record<string, Take>; rects: Record<string, Rect>; exportName: string };
const T1 = DATA.takes.t1;
const R = DATA.rects;
const EXPORT_NAME = DATA.exportName;

// ═══ The edit ═════════════════════════════════════════════════════════════
// Every start is a beat (or half beat) of the track; every line's length on
// screen comes from the one text rhythm in lib.tsx, never from the music.
// Before the logo every line holds only for reading time (READ in lib.tsx,
// ~0.3s once its last word has settled), so the chain fills 0→8.27 with no
// dead gaps. In the demo a caption stays up while its action is on screen.
const L1 = 'giving website feedback / is messy';
const L1_AT = B(0.5);
const L1_OUT = B(0.5) + 90 + 12; // 200ms (12f) after "messy" has fully appeared (settled at 109), the others leave
const GLIDE_AT = L1_OUT + 8; // once the others have mostly faded, so the move reads on its own
const GLIDE = 36;
const PROPS_AT = B(5); // the pile starts landing around the word as it settles
const PROP_GAP = 17; // a slower stagger than an eighth note (15.4f)
const PROPS_OUT = 316; // the full pile holds ~0.47s; gone (338) just before "but" (342)
const NOT = 'but not anymore';
const NOT_AT = B(11);
const NOT_OUT = NOT_AT + 59 + 12; // 200ms after it has fully appeared (settled at 401)
const HI = 'say hi to';
const HI_AT = B(14);
const LOGO1_AT = B(16); // the bam
const HI_OUT = B(17); // stays above the logo for half a second after it lands
const TAG1 = 'website feedback made very very easy';
const TAG1_AT = B(17);
const HELLO_OUT = B(20.75); // the tagline settles at 632 and reads 0.3s; the brand card leaves, gone 662
const HELLO_LIFT = 44; // logo + tagline centre on the frame once "say hi to" has left
const WIN_AT = B(21.5);
// The demo, one calm cadence: a discrete action every 2 beats (the take's clicks).
const ICON_CLICK = B(26);
const ADD1 = B(28);
const PLACE1 = B(32); // the drop
const NOTE1 = B(34.5); // click into the note
const SAVE1 = B(36.5);
const ADD2 = B(38.5);
const PLACE2 = B(40.5);
const SAVE2 = B(42.5);
const EXPORT_AT = B(46.5);
const CAPS: { text: string; at: number; accent: string[]; outAt: number }[] = [
  { text: 'launch salamander', at: B(22.5), accent: ['salamander'], outAt: ADD1 + 15 }, // through the icon click and add note turning yellow
  { text: 'point at anything', at: B(30), accent: ['anything'], outAt: B(33) }, // as the camera returns to the page; the box lands on the drop
  { text: "say what's wrong", at: B(34), accent: ['wrong'], outAt: SAVE1 + 6 }, // the click into the note, the typing, the save
  { text: 'add as many as you want', at: B(37.5), accent: ['many'], outAt: SAVE2 + 6 }, // note 2, add to save
  { text: "it's that easy", at: B(44), accent: ['easy'], outAt: EXPORT_AT }, // the list, up to the export click
];
const SHARE_CAP = 'export for your team, or your ai agent';
const SHARE_AT = B(47); // with the zip's pop
const PNS = 'point. note. share.'; // the one line that keeps its periods (client)
const PNS_AT = B(60.5);
const LOGO2_AT = B(64);
const PNS_OUT = LOGO2_AT - 24; // reading time (0.4s), gone 12f before the logo
const CTA = 'add to chrome\u00A0—\u00A0it’s free'; // the dash travels with its words
const CTA_AT = B(66); // a beat after logo 2 lands, so the logo never sits alone
const FADE_AT = DURATION - 36;

// ═══ Footage ══════════════════════════════════════════════════════════════
const takeTime = (f: number) => f / FPS - T1.filmStart;
function frameIndex(t: number): number {
  const fr = T1.frames;
  if (t <= fr[0]) return 0;
  let lo = 0, hi = fr.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (fr[m] <= t) lo = m; else hi = m - 1; }
  return lo;
}
function cursorAt(t: number): LogEntry {
  const L = T1.log;
  if (t <= L[0].t) return L[0];
  for (let i = 1; i < L.length; i++) {
    if (L[i].t >= t) {
      const a = L[i - 1], b = L[i];
      const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return { ...b, x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), pencil: b.pencil ?? a.pencil };
    }
  }
  return L[L.length - 1];
}
function pressAt(t: number, only: (e: LogEntry) => boolean = () => true): number {
  let p = 0;
  for (const e of T1.log) {
    if (e.kind !== 'down' || !only(e)) continue;
    const d = t - e.t;
    if (d > -0.07 && d < 0.2) p = Math.max(p, d < 0 ? (d + 0.07) / 0.07 : 1 - d / 0.2);
  }
  return p;
}
const EXPORT_CLICK = Math.round((T1.filmStart + T1.log.filter((e) => e.kind === 'down').pop()!.t) * FPS);

// ═══ Camera: the whole window (chrome and page) scales and pans ═══════════
// Page coordinates: the viewport is 1600×880; the browser bar sits above it.
const VW = 1600, VH = 880, BARP = 44;
const S = 0.9; // window scale at rest
const TOP = 196; // the window's top edge whenever a caption can be on screen
type Cam = { z: number; cx: number; ty: number };
const HOME: Cam = { z: 1, cx: VW / 2, ty: TOP };
type Key = Cam & { f: number };
// Launch: close on the toolbar's top right, the extension icon and (once the
// sidebar is open) its add note button both in frame. The footage is 2x, so
// the window's scale stays at about 2 (z 2.3 → 2.07) to keep it sharp.
const LAUNCH: Cam = { z: 2.3, cx: 1200, ty: TOP };
// The typo and its note: the window grows down and right, its top edge pinned.
const A: Cam = { z: 1.95, cx: 500, ty: TOP };
// Note 2, under its caption: top pinned, the sidebar and the button's comment box in frame.
const CARDS: Cam = { z: 1.07, cx: 850, ty: TOP };
// The list and export.
const LIST: Cam = { z: 1.35 / S, cx: 877, ty: TOP }; // right edge just past the frame
const CAM: Key[] = [
  { f: WIN_AT, ...HOME }, { f: B(23), ...HOME },
  // the push onto the toolbar, at the film's camera pace (1.15s); it lands
  // before the icon click, and the sidebar then slides in (SIDEBAR_SLIDE)
  { f: B(25.25), ...LAUNCH }, { f: B(29.5), ...LAUNCH },
  // one direct move back to the page (1.22s), landing just before the box is placed on the drop
  { f: B(31.85), ...A }, { f: SAVE1, ...A },
  { f: ADD2, ...CARDS }, { f: SAVE2, ...CARDS },
  { f: B(44.5), ...LIST }, { f: 9999, ...LIST },
];
function camAt(f: number): Cam {
  if (f <= CAM[0].f) return CAM[0];
  for (let i = 0; i < CAM.length - 1; i++) {
    const a = CAM[i], b = CAM[i + 1];
    if (f >= a.f && f < b.f) {
      const t = EASE.inOut((f - a.f) / (b.f - a.f));
      return { z: Math.exp(lerp(Math.log(a.z), Math.log(b.z), t)), cx: lerp(a.cx, b.cx, t), ty: lerp(a.ty, b.ty, t) };
    }
  }
  return CAM[CAM.length - 1];
}
/** Window placement in the frame: left, top, scale. */
const place = (c: Cam) => { const s = S * c.z; return { s, l: W / 2 - c.cx * s, t: c.ty }; };
const toScreen = (c: Cam, px: number, py: number): [number, number] => {
  const p = place(c);
  return [p.l + px * p.s, p.t + (BARP + py) * p.s];
};

// ═══ 1. The problem ═══════════════════════════════════════════════════════
const Bubble: React.FC<{ text: string; me?: boolean }> = ({ text, me }) => (
  <div style={{ fontFamily: FONT, fontSize: 30, fontWeight: 500, color: me ? '#14120D' : C.text, background: me ? '#E9E3D3' : '#2A261C', padding: '18px 26px', borderRadius: 28, borderBottomLeftRadius: me ? 28 : 8, borderBottomRightRadius: me ? 8 : 28, whiteSpace: 'nowrap', boxShadow: '0 20px 50px rgba(0,0,0,0.45)' }}>{text}</div>
);
const ShotCard: React.FC<{ r: Rect; label: string; width: number; mark: 'circle' | 'arrow' }> = ({ r, label, width, mark }) => {
  const k = width / r.w, hgt = r.h * k;
  return (
    <div style={{ background: '#F4F4F5', borderRadius: 14, padding: 10, boxShadow: '0 30px 70px rgba(0,0,0,0.5)', width: width + 20 }}>
      <div style={{ position: 'relative', width, height: hgt, overflow: 'hidden', borderRadius: 6 }}>
        <Img src={staticFile('take/t1/0.jpg')} style={{ position: 'absolute', width: VW * k, height: VH * k, left: -r.x * k, top: -r.y * k, filter: 'saturate(0.8)' }} />
        <svg width={width} height={hgt} style={{ position: 'absolute', inset: 0 }}>
          {mark === 'circle'
            ? <ellipse cx={width * 0.5} cy={hgt * 0.55} rx={width * 0.4} ry={hgt * 0.32} fill="none" stroke="#EF4444" strokeWidth={5} transform={`rotate(-4 ${width / 2} ${hgt / 2})`} />
            : <path d={`M ${width * 0.92} ${hgt * 0.12} Q ${width * 0.78} ${hgt * 0.22} ${width * 0.66} ${hgt * 0.5} M ${width * 0.66} ${hgt * 0.5} l 22 -6 M ${width * 0.66} ${hgt * 0.5} l 4 -22`} fill="none" stroke="#EF4444" strokeWidth={5} strokeLinecap="round" />}
        </svg>
      </div>
      <div style={{ fontFamily: FONT, fontSize: 18, color: '#52525B', padding: '10px 4px 2px' }}>{label}</div>
    </div>
  );
};
const EmailCard: React.FC = () => (
  <div style={{ width: 430, background: '#FAFAF9', borderRadius: 16, padding: '20px 24px', boxShadow: '0 30px 70px rgba(0,0,0,0.5)', fontFamily: FONT }}>
    <div style={{ fontSize: 17, color: '#71717A' }}>from: dana · 14 replies</div>
    <div style={{ fontSize: 25, fontWeight: 600, color: '#18181B', marginTop: 6 }}>re: re: fwd: website feedback</div>
    <div style={{ fontSize: 20, color: '#52525B', marginTop: 8 }}>see attached (the other one)</div>
  </div>
);
const Sticky: React.FC = () => (
  <div style={{ width: 250, height: 200, background: '#FDE68A', padding: 24, boxShadow: '0 26px 60px rgba(0,0,0,0.5)', fontFamily: '"Marker Felt", "Comic Sans MS", cursive', fontSize: 31, color: '#3F3A2A', lineHeight: 1.2 }}>fix the typo on pricing!!</div>
);
const ctaClosed = R['cta-business@closed'];
const statClosed = R['stat-events@closed'];
/** The pile, in arrival order: alternating sides, overlapping one another,
 *  every piece clear of the centred word so "messy." always reads on top. */
const PROPS: { x: number; y: number; r: number; node: React.ReactNode }[] = [
  { x: 640, y: 375, r: -9, node: <ShotCard r={{ x: ctaClosed.x - 30, y: ctaClosed.y - 24, w: ctaClosed.w + 60, h: ctaClosed.h + 48 }} label="screenshot_final_v3 (2).png" width={330} mark="circle" /> },
  { x: 1255, y: 395, r: 7, node: <Bubble text="which button??" /> },
  { x: 1250, y: 705, r: -5, node: <EmailCard /> },
  { x: 700, y: 690, r: 4, node: <Bubble text="the thing next to the price is off" me /> },
  { x: 470, y: 560, r: -11, node: <Sticky /> },
  { x: 1450, y: 545, r: 6, node: <ShotCard r={{ x: statClosed.x - 24, y: statClosed.y - 16, w: 560, h: statClosed.h + 32 }} label="img_4412.png" width={360} mark="arrow" /> },
  { x: 985, y: 330, r: -4, node: <Bubble text="it's broken on my laptop" /> },
];
const PROP_SCALE = 1.1;
const PROP_IN = 28;
const PROP_OUT = 16;
const PROPS_GONE = PROPS_OUT + (PROPS.length - 1) + PROP_OUT;

const Center: React.FC<{ children: React.ReactNode; y?: number }> = ({ children, y = 540 }) => (
  <div style={{ position: 'absolute', left: 0, width: W, top: y, transform: 'translateY(-50%)', display: 'flex', justifyContent: 'center' }}>{children}</div>
);

/** "giving website feedback / is messy.", word by word; then the other words
 *  leave and the same "messy." element glides to the exact centre of the
 *  frame, where it stays on top of the pile until the pile leaves. */
const MESSY_GROW = 1.12;
const LINE_STYLE: React.CSSProperties = { fontFamily: FONT, fontWeight: 600, fontSize: HERO, letterSpacing: '-0.03em', lineHeight: 1.12, color: C.text, textAlign: 'center', whiteSpace: 'nowrap' };
const SERIF_SPAN: React.CSSProperties = { fontFamily: SERIF, fontStyle: 'italic', fontWeight: 400, fontSize: '1.06em', letterSpacing: '-0.005em' };
const HEAD_LINES = [['giving', 'website', 'feedback'], ['is', 'messy']];
let messyOffset: [number, number] | null = null;
const Headline: React.FC = () => {
  const f = useCurrentFrame();
  const frame = useRef<HTMLDivElement>(null);
  const word = useRef<HTMLSpanElement>(null);
  // Where "messy." sits in the two-line layout, measured once the fonts are in
  // (on an untransformed hidden copy), as an offset from the frame's centre.
  // The frame is held until the measured offset has been committed.
  const [off, setOff] = useState<[number, number] | null>(messyOffset);
  const [handle] = useState(() => (messyOffset ? null : delayRender('measure messy')));
  useLayoutEffect(() => {
    if (off) return;
    let alive = true;
    document.fonts.ready.then(() => {
      if (!alive || !frame.current || !word.current) return;
      // Relative to the hidden line's own box (W wide, centred on the frame's
      // middle), so it holds wherever and at whatever scale the page is laid out.
      const box = frame.current.getBoundingClientRect(), r = word.current.getBoundingClientRect();
      const k = box.width > 0 ? W / box.width : 1;
      messyOffset = [(r.left + r.width / 2 - (box.left + box.width / 2)) * k, (r.top + r.height / 2 - (box.top + box.height / 2)) * k];
      setOff(messyOffset);
    });
    return () => { alive = false; };
  }, [off]);
  useEffect(() => { if (off && handle !== null) continueRender(handle); }, [off, handle]);
  const [ox, oy] = off ?? [0, 0];
  const others = prog(f, L1_OUT, L1_OUT + LINE_OUT, EASE.in);
  const glide = prog(f, GLIDE_AT, GLIDE_AT + GLIDE, EASE.inOut);
  const gone = prog(f, PROPS_OUT, PROPS_OUT + LINE_OUT, EASE.in);
  const lines = (live: boolean) => {
    let k = 0;
    return HEAD_LINES.map((line, li) => (
      <div key={li}>
        {line.map((w, wi) => {
          const i = k++;
          const hi = w === 'messy';
          const w0 = wordAt(L1_AT, i);
          const t = live ? prog(f, w0, w0 + WORD_IN, EASE.out) : 1;
          const exit = hi ? gone : others;
          const move = hi && live ? `translate(${-ox * glide}px, ${-oy * glide}px) scale(${lerp(1, MESSY_GROW, glide)})` : '';
          return (
            <React.Fragment key={wi}>
              {wi > 0 ? ' ' : null}
              <span ref={hi && !live ? word : undefined} style={{
                display: 'inline-block', position: 'relative', zIndex: hi ? 2 : 1,
                opacity: live ? t * (1 - exit) : 1,
                transform: live ? `${move} translateY(${(1 - t) * 0.32 - exit * 0.12}em)` : undefined,
                ...(hi ? SERIF_SPAN : null),
              }}>{w}</span>
            </React.Fragment>
          );
        })}
      </div>
    ));
  };
  return (
    <AbsoluteFill>
      <div ref={frame} style={{ position: 'absolute', left: 0, width: W, top: H / 2, transform: 'translateY(-50%)', visibility: 'hidden' }}>
        <div style={LINE_STYLE}>{lines(false)}</div>
      </div>
      <Center><div style={LINE_STYLE}>{lines(true)}</div></Center>
    </AbsoluteFill>
  );
};

const Problem: React.FC = () => {
  const f = useCurrentFrame();
  if (f > PROPS_GONE + 2) return null;
  return (
    <AbsoluteFill>
      {PROPS.map((p, i) => {
        const at = Math.round(PROPS_AT + i * PROP_GAP);
        if (f < at) return null;
        const t = prog(f, at, at + PROP_IN, EASE.land);
        const leaveAt = PROPS_OUT + (PROPS.length - 1 - i);
        const e = prog(f, leaveAt, leaveAt + PROP_OUT, EASE.in);
        // leave outward, away from the middle
        const dx = (p.x - 960) / 960, dy = (p.y - 540) / 540;
        const drift = (f - at) * 0.05;
        return (
          <div key={i} style={{
            position: 'absolute', left: p.x, top: p.y,
            transform: `translate(-50%, -50%) translate(${dx * e * 40}px, ${(1 - t) * 44 - drift + dy * e * 40}px) rotate(${p.r}deg) scale(${PROP_SCALE * (0.94 + 0.06 * t) * (1 - e * 0.04)})`,
            opacity: Math.min(1, t * 1.6) * (1 - e),
          }}>{p.node}</div>
        );
      })}
      {/* on top of the pile */}
      <Headline />
    </AbsoluteFill>
  );
};

/** "but not anymore." */
const NotAnymore: React.FC = () => {
  const f = useCurrentFrame();
  if (f < NOT_AT - 2 || f > NOT_OUT + LINE_OUT + 2) return null;
  return <Center><Words text={NOT} at={NOT_AT} outAt={NOT_OUT} size={HERO} accent={['anymore']} /></Center>;
};

// ═══ The logo ═════════════════════════════════════════════════════════════
/** The face mark and the wordmark land together, as one unit: a small rise
 *  and scale settle on the heavy curve. */
const LOGO_IN = 32;
const Logo: React.FC<{ at: number; out?: number; y: number; size: number }> = ({ at, out, y, size }) => {
  const f = useCurrentFrame();
  if (f < at - 1 || (out !== undefined && f > out + LINE_OUT + 2)) return null;
  const land = prog(f, at, at + LOGO_IN, EASE.land);
  const op = prog(f, at, at + 20, EASE.std);
  const exit = out === undefined ? 0 : prog(f, out, out + LINE_OUT, EASE.in);
  return (
    <div style={{ position: 'absolute', left: 0, width: W, top: y, transform: `translateY(-50%) translateY(${(1 - land) * 26 - exit * 16}px)`, opacity: op * (1 - exit), display: 'flex', justifyContent: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: size * 0.2, transform: `scale(${0.95 + 0.05 * land})` }}>
        <Img src={staticFile('brand/logo.svg')} style={{ width: size * 1.6, height: size * 0.915 }} />
        <div style={{ fontFamily: SERIF, fontStyle: 'italic', fontSize: size * 1.25, color: C.text, letterSpacing: '-0.01em', lineHeight: 1 }}>salamander</div>
      </div>
    </div>
  );
};

const Hello: React.FC = () => {
  const f = useCurrentFrame();
  if (f < HI_AT - 2 || f > HELLO_OUT + 20) return null;
  // once "say hi to" has gone, the logo and tagline drift up to sit centred
  const lift = HELLO_LIFT * prog(f, HI_OUT, HI_OUT + 60, EASE.inOut);
  return (
    <AbsoluteFill>
      <Center y={378}><Words text={HI} at={HI_AT} outAt={HI_OUT} size={HERO} /></Center>
      <Logo at={LOGO1_AT} out={HELLO_OUT} y={540 - lift} size={124} />
      <Center y={668 - lift}><Words text={TAG1} at={TAG1_AT} outAt={HELLO_OUT} size={SUB} weight={500} color={C.text} accent={['very', 'easy']} /></Center>
    </AbsoluteFill>
  );
};

// ═══ 2. The product ═══════════════════════════════════════════════════════
const BrowserBar: React.FC<{ iconPress: number }> = ({ iconPress }) => (
  <div style={{ position: 'absolute', left: 0, top: 0, width: VW, height: BARP, background: '#ECECEF', borderBottom: '1px solid #DADADF' }}>
    <div style={{ position: 'absolute', left: 18, top: BARP / 2 - 7, display: 'flex', gap: 9 }}>
      {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => <div key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />)}
    </div>
    <div style={{ position: 'absolute', left: VW / 2 - 260, top: 8, width: 520, height: 28, borderRadius: 9, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontFamily: FONT, fontSize: 15, color: '#3F3F46' }}>
      <svg width="11" height="13" viewBox="0 0 11 13"><rect x="1" y="5.5" width="9" height="7" rx="1.6" fill="#71717A" /><path d="M3 5.5V4a2.5 2.5 0 015 0v1.5" fill="none" stroke="#71717A" strokeWidth="1.5" /></svg>
      orbit.example/pricing
    </div>
    {/* the extension's toolbar icon, where the take clicks it */}
    <div style={{ position: 'absolute', left: VW - 26 - 14, top: BARP / 2 - 14, width: 28, height: 28, borderRadius: 8, background: '#14120D', display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${1 - iconPress * 0.12})` }}>
      <Img src={staticFile('brand/logo.svg')} style={{ width: 20, height: 11.4 }} />
    </div>
  </div>
);

const WIN_IN = 40;
// The real extension shows its sidebar instantly; here it slides in from the
// window's right edge over 28f on the heavy curve. During the slide the page
// is the last pre-click frame (shifted with the reflow) and the sidebar is
// the real post-click frame from the slide's end, cut at its left border.
const SIDEBAR_SLIDE = 28;
const SIDE_X = 1300; // the sidebar's left edge (300px wide)
const REFLOW = 150; // the page's centred wrap moves left by half the sidebar's width
const PRE_IDX = frameIndex(takeTime(ICON_CLICK));
const SIDE_IDX = frameIndex(takeTime(ICON_CLICK + SIDEBAR_SLIDE));
const WIN_OUT_AT = EXPORT_CLICK + 12; // the zip chip's pop has finished before the window moves
const WIN_OUT = 24;

const Product: React.FC = () => {
  const f = useCurrentFrame();
  if (f < WIN_AT - 1 || f > WIN_OUT_AT + WIN_OUT + 1) return null;
  const enter = prog(f, WIN_AT, WIN_AT + WIN_IN, EASE.land);
  const exit = prog(f, WIN_OUT_AT, WIN_OUT_AT + WIN_OUT, EASE.in);
  const cam = camAt(f);
  const p = place(cam);
  const dy = (1 - enter) * 120 + exit * 120;
  const op = enter * (1 - exit);
  const tt = takeTime(f);
  const idx = frameIndex(Math.max(0, tt));
  const cur = cursorAt(tt);
  const [sx, sy] = toScreen(cam, cur.x, cur.y);
  const curOp = prog(f, WIN_AT + 4, WIN_AT + 18, EASE.std);
  const slide = prog(f, ICON_CLICK, ICON_CLICK + SIDEBAR_SLIDE, EASE.land);
  const sideL = SIDE_X + (VW - SIDE_X) * (1 - slide);
  return (
    <AbsoluteFill style={{ opacity: op, transform: `translateY(${dy}px)` }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: VW, height: VH + BARP, transformOrigin: '0 0', transform: `translate(${p.l}px, ${p.t}px) scale(${p.s})`, borderRadius: 16, overflow: 'hidden', background: '#fff', boxShadow: '0 40px 120px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.07)' }}>
        <BrowserBar iconPress={pressAt(tt, (e) => !!e.virtual)} />
        {slide < 1 && f >= ICON_CLICK ? (
          <>
            {/* the page: the pre-click frame, shifting left as the real reflow does (its centred wrap moves 150px) */}
            <div style={{ position: 'absolute', left: 0, top: BARP, width: sideL, height: VH, overflow: 'hidden' }}>
              <Img src={staticFile(`take/t1/${PRE_IDX}.jpg`)} style={{ position: 'absolute', left: -REFLOW * slide, top: 0, width: VW, height: VH }} />
            </div>
            {/* the sidebar: the real footage once open, sliding in from the window's right edge */}
            <div style={{ position: 'absolute', left: sideL, top: BARP, width: VW - SIDE_X, height: VH, overflow: 'hidden' }}>
              <Img src={staticFile(`take/t1/${SIDE_IDX}.jpg`)} style={{ position: 'absolute', left: -SIDE_X, top: 0, width: VW, height: VH }} />
            </div>
          </>
        ) : (
          <Img src={staticFile(`take/t1/${idx}.jpg`)} style={{ position: 'absolute', left: 0, top: BARP, width: VW, height: VH }} />
        )}
      </div>
      <Cursor x={sx} y={sy} press={pressAt(tt)} opacity={curOp} pencil={!!cur.pencil} scale={Math.pow(cam.z, 0.6)} />
    </AbsoluteFill>
  );
};

/** Captions: one line in the band above the window, each gone before the next. */
const CAP_Y = 104;
const Captions: React.FC = () => (
  <>
    {CAPS.map(({ text, at, accent, outAt }) => (
      <Center key={text} y={CAP_Y}><Words text={text} at={at} outAt={outAt} size={CAP} accent={accent} /></Center>
    ))}
  </>
);

// ═══ 3. Sharing ═══════════════════════════════════════════════════════════
const Card: React.FC<{ title: string; children: React.ReactNode; style?: React.CSSProperties }> = ({ title, children, style }) => (
  <div style={{ position: 'absolute', width: 780, height: 470, borderRadius: 26, background: C.surface, border: `1px solid ${C.line}`, boxShadow: '0 40px 120px rgba(0,0,0,0.5)', overflow: 'hidden', ...style }}>
    <div style={{ height: 58, display: 'flex', alignItems: 'center', gap: 12, padding: '0 26px', borderBottom: `1px solid ${C.line}`, fontFamily: FONT, fontSize: 22, color: C.muted, fontWeight: 500 }}>
      <div style={{ width: 10, height: 10, borderRadius: 5, background: C.accent }} />{title}
    </div>
    {children}
  </div>
);
const ZipIcon: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size * 1.15} viewBox="0 0 40 46">
    <path d="M4 4a4 4 0 014-4h18l10 10v32a4 4 0 01-4 4H8a4 4 0 01-4-4V4z" fill={C.accent} />
    <path d="M26 0v8a2 2 0 002 2h8" fill="#E2B000" />
    {[0, 1, 2, 3, 4].map((i) => <rect key={i} x={i % 2 ? 16 : 12} y={6 + i * 5} width={6} height={3} rx={1} fill="#14120D" />)}
    <rect x={11} y={31} width={12} height={9} rx={2} fill="#14120D" />
  </svg>
);
/** feedback.md, rendered */
const DOC: { kind: 'meta' | 'h2' | 'h3' | 'img' | 'note'; text?: string }[] = [
  { kind: 'meta', text: 'salamander 2.1.0 · orbit.example' },
  { kind: 'h2', text: 'page “orbit.example/pricing”' },
  { kind: 'h3', text: 'feedback 1' },
  { kind: 'img' },
  { kind: 'note', text: 'typo: should be “receive”' },
  { kind: 'h3', text: 'feedback 2' },
  { kind: 'note', text: 'make this button match the others' },
];

// The chip pops at the export button and waits there; the window sinks away
// under it; only once the window has gone does the chip travel, so nothing
// ever moves across a dissolving layer.
const ZIP_POP = EXPORT_CLICK;
const ZIP_GO = WIN_OUT_AT + WIN_OUT + 2;
const ZIP_Y = 300;
const CARD_Y = 420;
const MD_AT = ZIP_GO + 2;
const AI_AT = MD_AT + 20;
const MSG = 'hey claude, fix these issues';
const SEND_AT = B(56); // where the bass drops out
const TYPE_CPS = 34; // reads as quick typing, not a paste
const TYPE_END = SEND_AT - 16; // a short pause, then send
const TYPE_AT = TYPE_END - Math.round((MSG.length / TYPE_CPS) * FPS);
// The one zip chip, after it has waited at the top, moves into the prompt
// box's attachment slot as the caption settles (one object, never two).
const ATTACH_AT = B(52);
const ATTACH = 36;
const SLOT_X = 980 + 1 + 26 + 1 + 18; // card left + border + box inset + border + padding
const SLOT_Y = CARD_Y + 1 + (470 - 2 - 26 - 156) + 1 + 16 + 19; // the attached chip's vertical middle
const CARDS_OUT = SEND_AT + 100; // the sent message reads for over a second, then everything leaves

const Share: React.FC = () => {
  const f = useCurrentFrame();
  const out = CARDS_OUT;
  if (f < ZIP_POP || f > out + 20) return null;
  const exit = prog(f, out, out + 16, EASE.in);
  const [ex, ey] = toScreen(camAt(EXPORT_CLICK), R.btnExport.x + R.btnExport.w / 2, R.btnExport.y + R.btnExport.h / 2);
  const zip = prog(f, ZIP_POP, ZIP_POP + 12, EASE.land);
  const zipTravel = prog(f, ZIP_GO, ZIP_GO + 36, EASE.inOut);
  const md = prog(f, MD_AT, MD_AT + 36, EASE.land);
  const ai = prog(f, AI_AT, AI_AT + 36, EASE.land);
  const typed = Math.round(prog(f, TYPE_AT, TYPE_END, (t) => t) * MSG.length);
  const sendPress = f > SEND_AT - 4 && f < SEND_AT + 8 ? (f < SEND_AT ? (f - SEND_AT + 4) / 4 : 1 - (f - SEND_AT) / 8) : 0;
  const cleared = prog(f, SEND_AT + 2, SEND_AT + 8, EASE.std);
  const sent = prog(f, SEND_AT + 2, SEND_AT + 26, EASE.out);
  // pops over the export button but kept whole inside the frame (it is ~660px wide)
  const px = Math.min(ex, W - 56 - 330);
  const zx = lerp(px, W / 2, zipTravel), zy = lerp(ey, ZIP_Y, zipTravel);
  const attach = prog(f, ATTACH_AT, ATTACH_AT + ATTACH, EASE.inOut);
  // across first, then down, so the chip clears the feedback.md card's corner
  const ax = lerp(zx, SLOT_X, prog(f, ATTACH_AT, ATTACH_AT + ATTACH, EASE.out)), ay = lerp(zy, SLOT_Y, attach);
  const sub = 1 - prog(attach, 0, 0.5, (t) => t);
  // no caret until the typing is about to begin: the box reads as ready, not waiting
  const caret = f >= TYPE_AT - 6 && (typed < MSG.length || f < SEND_AT) ? (Math.floor((f - TYPE_AT + 6) / 16) % 2 === 0 ? 1 : 0) : 0;
  return (
    <AbsoluteFill style={{ opacity: 1 - exit, transform: `translateY(${-exit * 16}px)` }}>
      <Card title="feedback.md" style={{ left: 160, top: CARD_Y + (1 - md) * 48, opacity: md }}>
        <div style={{ padding: '20px 34px', fontFamily: FONT, color: C.text }}>
          {DOC.map((d, i) => {
            const v = prog(f, MD_AT + 10 + i * 5, MD_AT + 10 + i * 5 + 28, EASE.out);
            const st: React.CSSProperties = { opacity: v, transform: `translateY(${(1 - v) * 10}px)` };
            if (d.kind === 'img') return <Img key={i} src={staticFile('take/shot-1.png')} style={{ ...st, display: 'block', height: 100, borderRadius: 8, margin: '8px 0 10px' }} />;
            if (d.kind === 'meta') return <div key={i} style={{ ...st, fontSize: 17, color: C.muted, marginBottom: 10 }}>{d.text}</div>;
            if (d.kind === 'h2') return <div key={i} style={{ ...st, fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', marginBottom: 8 }}>{d.text}</div>;
            if (d.kind === 'h3') return <div key={i} style={{ ...st, fontSize: 21, fontWeight: 600, color: C.accent, marginTop: 8 }}>{d.text}</div>;
            return <div key={i} style={{ ...st, fontSize: 21, color: '#E9E3D3', marginTop: 2 }}><b style={{ color: C.text, fontWeight: 700 }}>note:</b> {d.text}</div>;
          })}
        </div>
      </Card>
      <Card title="your ai agent" style={{ left: 980, top: CARD_Y + (1 - ai) * 48, opacity: ai }}>
        {/* the sent message */}
        <div style={{ position: 'absolute', right: 26, top: 84, maxWidth: 560, opacity: sent, transform: `translateY(${(1 - sent) * 60}px)`, background: '#2A261C', borderRadius: 20, borderBottomRightRadius: 6, padding: '14px 18px', fontFamily: FONT }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 16, color: C.muted, marginBottom: 8 }}><ZipIcon size={18} />{EXPORT_NAME}</div>
          <div style={{ fontSize: 23, color: C.text }}>{MSG}</div>
        </div>
        {/* the prompt box */}
        <div style={{ position: 'absolute', left: 26, right: 26, bottom: 26, height: 156, borderRadius: 20, background: C.bg, border: `1px solid ${C.line}`, padding: '16px 18px', fontFamily: FONT }}>
          {/* the attachment slot the zip chip moves into (layout only) */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '8px 12px', border: '1px solid transparent', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', visibility: 'hidden', whiteSpace: 'nowrap' }}>
            <ZipIcon size={18} />{EXPORT_NAME}
          </div>
          <div style={{ marginTop: 14, fontSize: 25, color: C.text, opacity: 1 - cleared }}>
            {MSG.slice(0, typed)}<span style={{ opacity: caret, color: C.accent }}>|</span>
          </div>
          <div style={{ position: 'absolute', right: 16, bottom: 16, width: 48, height: 48, borderRadius: 24, background: C.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${1 - sendPress * 0.12})` }}>
            <svg width="20" height="20" viewBox="0 0 20 20"><path d="M10 16V4M4.5 9.5L10 4l5.5 5.5" fill="none" stroke="#14120D" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
        </div>
      </Card>
      {/* the zip: pops at the export button, waits at the top, then becomes the prompt's attachment */}
      <div style={{ position: 'absolute', left: ax, top: ay, transform: `translate(${-50 * (1 - attach)}%, -50%) scale(${0.6 + 0.4 * zip})`, transformOrigin: `${50 * (1 - attach)}% 50%`, opacity: Math.min(1, zip * 2) * (1 - cleared) }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: lerp(24, 10, attach),
          padding: `${lerp(22, 8, attach)}px ${lerp(34, 12, attach)}px ${lerp(22, 8, attach)}px ${lerp(26, 12, attach)}px`,
          borderRadius: lerp(26, 12, attach), background: interpolateColors(attach, [0, 1], [C.surface, '#2A261C']),
          border: `1px solid ${interpolateColors(attach, [0, 1], [C.line, 'rgba(58,52,39,0)'])}`,
          boxShadow: `0 ${lerp(40, 0, attach)}px ${lerp(100, 0, attach)}px rgba(0,0,0,${lerp(0.5, 0, attach)})`, whiteSpace: 'nowrap',
        }}>
          <ZipIcon size={lerp(54, 18, attach)} />
          <div style={{ fontFamily: FONT }}>
            <div style={{ fontSize: lerp(28, 16, attach), fontWeight: 600, color: C.text, letterSpacing: '-0.01em' }}>{EXPORT_NAME}</div>
            <div style={{ fontSize: 20, color: C.muted, marginTop: lerp(5, 0, attach), maxHeight: lerp(26, 0, attach), overflow: 'hidden', opacity: sub }}>2 notes · screenshots · feedback.md</div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// ═══ 4. The close ═════════════════════════════════════════════════════════
const Close: React.FC = () => {
  const f = useCurrentFrame();
  if (f < PNS_AT - 2) return null;
  const fade = prog(f, FADE_AT, DURATION - 2, EASE.inOut); // the last ~0.6s
  return (
    <AbsoluteFill>
      <Center><Words text={PNS} at={PNS_AT} outAt={PNS_OUT} size={HERO} accent={['share']} /></Center>
      {/* logo + CTA, centred as a group */}
      <Logo at={LOGO2_AT} y={505} size={124} />
      <Center y={630}><Words text={CTA} at={CTA_AT} hold size={38} weight={500} color={C.text} style={{ letterSpacing: '-0.01em' }} /></Center>
      <AbsoluteFill style={{ background: C.bg, opacity: fade }} />
    </AbsoluteFill>
  );
};

// ═══ Film ═════════════════════════════════════════════════════════════════
export const Film: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: C.bg, fontFamily: FONT }}>
    <Audio src={staticFile('music5.mp3')} />
    <Problem />
    <NotAnymore />
    <Hello />
    <Product />
    <Captions />
    <Share />
    <Center y={CAP_Y}><Words text={SHARE_CAP} at={SHARE_AT} outAt={ATTACH_AT + ATTACH} size={CAP} accent={['team', 'ai', 'agent']} /></Center>
    <Close />
  </AbsoluteFill>
);

// Exported for the timing report.
export const TIMING = { L1_AT, L1_OUT, PROPS_AT, PROPS_OUT, PROPS_GONE, NOT_AT, HI_AT, HI_OUT, ICON_CLICK, PLACE1, NOTE1, ADD2, PLACE2, LOGO1_AT, TAG1_AT, HELLO_OUT, WIN_AT, EXPORT_CLICK, SHARE_AT, CARDS_OUT, TYPE_AT, SEND_AT, PNS_AT, LOGO2_AT, CTA_AT, FADE_AT, lineGone, LINE_OUT };
