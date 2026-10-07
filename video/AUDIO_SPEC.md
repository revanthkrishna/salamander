# Salamander launch film — frame-accurate audio specification

Film: `video/demo.mp4` · 38.767 s · 60 fps (1 frame = 0.0167 s) · 1920×1060 · no usable production audio.

Read this if you have never seen the film: §1 tells you what happens and when, §2 is the score (every note lands on a timestamp), §3 is the pulse those timestamps sit on, §4 is where the film differs from the director's brief, §5 is the single ElevenLabs music prompt for the whole piece, §6 the per-act fallback prompts, §7 how to lay the result against picture.

How the timestamps were obtained: a per-frame pixel-change signal for the whole video (whole frame, top 10 %, right quarter) located every candidate event; frame-by-frame JPEG bursts around each candidate identified what changed; a pixel-diff tool reported the bounding box of the change between consecutive frames when the eye could not tell. All times are the presentation time of the first frame on which the effect is visible, to 3 dp. The screen content updates at 20 fps inside a 60 fps container (UI events land on every third frame, ±0.017 s); the Cap zoom/pan moves and the mouse cursor update at the full 60 fps.

The soundtrack design principle (director's revised brief): there is no music bed. The notes tied to these events ARE the soundtrack: one continuous, very sparse composition, mostly silence, single instrument notes and short gestures on the events, gathering into a phrase three times (the arrival, the sweep, the close). No pads, no UI beeps, no whooshes, no synths, no vocals. Every sound is a real instrument playing a note or a short gesture.

---

## §1 Film anatomy

| Act | In | Out | Length | What happens |
|---|---|---|---|---|
| 1 The problem | 0.000 | 4.767 | 4.77 s | Full-frame view of the demo logistics dashboard. The cursor is already resting beside the page heading when the film opens, then visits three UI faults in turn: the "Add shipment" button (taller than "Filters" beside it) at 1.383, the "SPOILGE RATE" typo at 2.483, and the 7d/14d/30d date-range control that spills out of its card at 3.233. It then climbs to the Chrome toolbar (extensions icon, 4.717). |
| 2 The arrival | 4.767 | 7.467 | 2.70 s | Cap zooms into the top-right of the browser (4.767–5.483). The Extensions menu opens (5.183), the cursor moves to the "salamander" row, presses it (6.533), the menu closes (6.600) and the Salamander sidebar appears in a single frame (6.717), its logo mark popping in at 6.767. The cursor then rests until 7.467. This is the emotional pivot. |
| 3 The work | 7.467 | 29.883 | 22.42 s | The cursor hovers the add-note button, which reveals its second half, a toggle switch (8.167); the switch is flicked on at 10.717. Three captures follow. Each: the cursor leaves the sidebar, the page dims and a dashed highlight rectangle snaps to the element under the cursor, Cap zooms toward it, a click opens the note editor (13.450 / 19.333 / 26.383), a message is typed (13.950–16.050 / 21.933–22.850 / 27.167–27.817), save is pressed (17.000 / 24.267 / 29.700), the overlay vanishes in a "screenshot flash" and a thumbnail lands in the sidebar (17.600 / ≈24.617 / 29.883). In the second capture a yellow underline is drawn under the typo (20.900–21.283) before the message is typed. |
| 4 The flourish | 29.883 | 36.567 | 6.68 s | The cursor crosses the page (dim overlay re-engages 30.650), Cap zooms to the sidebar switch (30.983–31.800), the switch is flicked off (32.417), Cap zooms back out to full frame (32.467–33.350). The cursor then sweeps down the list of three thumbnails (1 → 2 → 3 magnify at 33.817 / 34.417 / 34.817, dock-style) and back up (2 → 1 at 35.583 / 35.867), leaving the list at 36.567. |
| 5 The close | 36.567 | 38.767 | 2.20 s | The cursor rises to the export (download) button, Cap zooms in on it (37.117–37.850), the button is pressed (38.150) and the macOS Save dialog appears (38.500). Picture ends 0.267 s later. |

Cap zoom/pan moves (whole-frame motion, not UI events; each ≈0.73–0.88 s, ease-in-out): 4.767→5.483 in · 12.833→13.567 pan · 17.000→17.750 out · 18.317→19.033 in · 24.733→25.467 in/pan · 30.983→31.800 in · 32.467→33.350 out · 37.117→37.850 in.

---

## §2 Cue sheet — the score

Columns: time (s, first frame the effect is visible) · what happens on screen · how it was determined · feeling · the sound's job · instrument / gesture · approximate length. "Pedal" means a single quiet held note, not a pad. Rows in **bold** are the structural events; the others are texture or silence markers. Where two timestamps are given (press / effect) the note goes on the one marked ●.

### Act 1 — The problem (rubato, no pulse)

| t | On screen | Determined by | Feeling | Sound's job | Instrument / gesture | Len |
|---|---|---|---|---|---|---|
| **0.000** | Film opens with the cursor already resting beside the page heading (the redundant heading). | Frames 0.000–0.800 identical cursor position; motion begins 0.817. | Something is off, unspoken. | Seed the unease; establish the solo voice. | Solo cello, one soft bowed note, no vibrato, low register, fading before the cursor leaves. | 0.8 s |
| 0.817 | Cursor leaves the heading. | Change signal rises (cursor motion). | — | Silence. | — | — |
| **1.383** | Cursor arrives on "Add shipment" (taller than "Filters" beside it). | Motion stops (change < 10 from 1.433); frame shows arrow tip on the button. | First "this is wrong". | Error hover 1: unresolved, slightly sour. | Cello, short bowed note with a second voice rubbing a hair off it; no resolution. | 0.4 s |
| 1.800 | Cursor leaves. | Motion resumes. | — | Silence. | — | — |
| **2.483** | Cursor arrives on the "SPOILGE RATE" typo. | Motion stops; frame. | Second, sharper. | Error hover 2: higher, more pressure. | Cello, higher register, scraped bow, shorter. | 0.3 s |
| 2.733 | Cursor leaves (shortest dwell). | Motion resumes. | — | Silence. | — | — |
| **3.233** | Cursor arrives on the 7d / 14d / 30d date-range control that overflows its card; rests there (small settling jitter to 3.500). | Motion stops; frames 3.217–4.150 show the arrow on "30d". | Third, most tense, left hanging. | Error hover 3: highest, choked off; completes the escalation without resolving it. | Cello, top of its register, pressed then cut; let a thin tail hang under the following silence. | 0.35 s + tail |
| 4.150 | Cursor leaves toward the toolbar. | Motion resumes. | — | Silence (the tail dies). | — | — |
| 4.717 | Cursor arrives on the Chrome extensions (puzzle) icon; hover circle visible. | Frame 4.717. | — | Nothing. | — | — |
| 4.767 | ZOOM IN starts toward the toolbar (ends 5.483). | 44-frame whole-frame run 4.767–5.483. | Leaning in. | Anticipation. | Cello harmonic, a quiet upward bowed swell across the zoom. | 0.7 s |

### Act 2 — The arrival (pulse begins; see §3)

| t | On screen | Determined by | Feeling | Sound's job | Instrument / gesture | Len |
|---|---|---|---|---|---|---|
| **5.183** | Extensions menu opens (effect of the click; the click itself is masked by the zoom). | Whole-frame change 207 460 on this frame; menu visible from 5.200 on. | A door opening. | Menu click. | Pizzicato double bass, one dry low pluck. | 0.3 s |
| 5.483 | Zoom-in settles. | End of run. | — | — | — | — |
| 5.883–6.000 | Cursor moves onto the "salamander" row; row highlight appears. | Frames. | — | Nothing (or a barely audible harp harmonic). | — | — |
| 6.533 | "salamander" row press state (mouse-down). | 74-cell change confined to the row. | — | See next row. | — | — |
| **6.600 ●** | Menu closes (effect of the salamander click). | Whole-frame change 200 107; menu gone on this frame. | Choice made. | App click. | Harp, one mid-register pluck, brighter than the bass. | 0.3 s |
| **6.717** | Salamander sidebar appears in ONE frame (no slide animation): dark panel with add-note button, export button, "no feedback on this page yet". | Right-quarter change 120 379 on this frame; 6.767 adds the logo. | Help has arrived. THE PIVOT. | The bloom: the film turns cheerful and heroic here. | Soft piano chord (open, warm, major-feeling, mid register) with a string swell rising into it and sustaining; the first moment two instruments play together. | 2.5 s decay |
| 6.767 | Logo mark (salamander face) pops in at the top of the sidebar. | Right-quarter 1 789. | Delight. | Sparkle on top of the bloom. | Celesta, one high note. | 0.3 s |
| 7.000–7.467 | Cursor rests. | No change. | Settling. | Let the chord ring down. | — | — |

### Act 3 — The work

| t | On screen | Determined by | Feeling | Sound's job | Instrument / gesture | Len |
|---|---|---|---|---|---|---|
| 7.467–8.133 | Cursor travels to the add-note (speech-bubble) button. | Motion. | — | Silence. | — | — |
| 8.133 | Cursor arrives on the button (hand cursor). | Motion stops. | — | — | — | — |
| **8.167** | The button reveals its second half: a toggle switch slides out beside the icon. | Frame 8.150 no switch, 8.167 switch present. | Curiosity, a question. | Reveal. | Piano or harp, a light two-note upward figure, question-like. | 0.4 s |
| 8.333–9.850 | Cursor drifts slowly right across the button toward the switch. | Low continuous motion. | — | Silence. | — | — |
| 10.150 | Cursor comes to rest on the switch. | Motion stops. | — | — | — | — |
| 10.650 | Switch press state (track lightens). | 42-cell change in the switch. | — | — | — | — |
| **10.717 ●** | Switch flicks ON: knob slides right, yellow fills (complete 10.767). | 42-cell change; frame shows knob right + fill. | Committed. | Switch on. | Marimba, a crisp low-to-high two-note snap. | 0.35 s |
| 10.850–11.700 | Rest. | No change. | — | Silence. | — | — |
| 11.717–12.050 | Cursor leaves the sidebar onto the page. | Motion. | — | — | — | — |
| **12.067** | Add mode engages on the page: page dims and a dashed hover rectangle appears under the cursor (fade in three 20 fps steps: 12.067, 12.117, 12.183). | Whole-frame changes 33 418 / 82 228 / 45 989. | Ready, aiming. | Ready pedal 1: a single quiet held note that stops on the click. | Viola, one low held note, ppp. | to 13.450 |
| 12.233–12.767 | Rectangle re-snaps element to element as the cursor moves (20 fps steps at 12.233, 12.300, 12.350, 12.417, 12.483, 12.533, 12.600, 12.650, 12.717, 12.767). | Mid-size changes every 3rd frame. | — | Nothing (optionally faint harp harmonics on 12.350 and 12.533). | — | — |
| 12.833 | Cap PAN starts toward the header buttons (ends 13.567). | 45-frame run. | — | — | — | — |
| **13.450** | CLICK 1: rectangle placed on the Filters / Add shipment group; the note editor opens ("what should change here?"). No press state visible. | Editor present on 13.450, absent on 13.433. | Decision. | Placement 1; pedal stops. | Piano, one firm mid-register note, soft attack. | 0.5 s |
| 13.567 | Tooltip fades; textarea focus ring on. | Frames. | — | — | — | — |
| **13.950** | Typing 1 begins ("m"). Message: "make the buttons the same size", 30 characters, scripted cadence with gaps at ≈14.05–14.40 and ≈14.90–15.32. | "m" visible on 13.950, absent on 13.917. | Productive. | Typing 1. | Felt piano, soft repeated single notes, 8–10 per second in bursts 13.95–14.05, 14.40–14.90, 15.32–15.95, and one at 16.05; mid register. | 2.1 s |
| 16.050 | Typing 1 ends (the "e" of "size"). | Pixel diff 16.033→16.050 at the caret; nothing after. | — | Typing stops. | — | — |
| 16.433–16.983 | Cursor moves to save; hand on save with hover highlight at 16.983. | Motion; frame. | — | Silence. | — | — |
| **17.000** | SAVE 1 press (button darkens) and ZOOM OUT starts on the same frame (ends 17.750). | Frame 17.000 shows pressed button and first zoom blur. | Done, satisfied. | Save 1. | Piano plus soft vibraphone, a two-note resolving figure (up, then rest). | 0.6 s |
| 17.433 | Editor, rectangle and dim vanish (screenshot flash: whole frame changes). | Whole-frame change 360 774. | — | Nothing. | — | — |
| **17.600** | Thumbnail 1 lands in the sidebar ("this page (1)"). | Right-quarter change 9 382; frame. | A small reward. | Thumbnail pop 1. | Celesta, one high note. | 0.3 s |
| 18.033–18.167 | Cursor moves onto the page. | Motion. | — | — | — | — |
| **18.200** | Dim + hover rectangle re-engage (steps 18.200, 18.250, 18.317). | 67 272 / 169 036 / 117 334. | Aiming again. | Ready pedal 2 (a different voice). | Cello, one held note, ppp, until 19.333. | to 19.333 |
| 18.317 | ZOOM IN starts toward the KPI cards (ends 19.033). | 44-frame run. | — | — | — | — |
| 19.067 | Rectangle settles on the SPOILGE RATE card. | 71-cell change. | — | — | — | — |
| **19.333** | CLICK 2: editor opens on the typo card. | Editor on 19.333, absent 19.317. | Decision. | Placement 2; pedal stops. | Harp, one pluck (different voice from capture 1). | 0.4 s |
| 19.633–19.650 | Cursor becomes a pencil: the draw tool engages. No click on the toolbar is visible; the cursor never travels to the pencil icon (likely a keyboard shortcut or scripted). | Frame 19.617 crosshair, 19.650 pencil. | Getting a pen out. | Optional: one soft upbeat note leading to the stroke, or silence. | Clarinet, a breath-tone pick-up. | 0.2 s |
| 20.083–20.150 | Textarea focus ring fades. | Diff bbox = editor outline. | — | Nothing. | — | — |
| **20.900** | DRAW starts: a yellow wavy underline grows under "SPOILGE". | Stroke first visible 20.900, absent 20.883. | Marking it. | Drawing: one gliding tone that follows the stroke. | Clarinet (or bowed vibraphone), a single sustained note that rises gently and wavers with the wavy line. | 0.38 s |
| 21.283 | Stroke ends / commits (pen up). | Stroke stops growing 21.267; 31-cell re-render 21.283. | — | The gliding tone lifts off. | — | — |
| 21.450 | Click into the textarea (caret appears; focus ring 21.517). | Frame 21.450 caret; 21.517 ring. | — | Optional tiny touch. | Harp harmonic, very soft. | 0.15 s |
| **21.933** | Typing 2 begins ("fi"). Message: "fix spelling", 12 characters. | "fi" on 21.933, placeholder on 21.917. | Lighter, quicker. | Typing 2. | Celesta / music-box, repeated notes, higher and lighter than typing 1. | 0.9 s |
| 22.850 | Typing 2 ends ("g"). | Diff 22.833→22.850 at caret. | — | — | — | — |
| 22.933–23.550 | Cursor to save; hover highlight on save at 23.567. | Motion; 19-cell changes. | — | Silence. | — | — |
| **24.267 ●** | SAVE 2 press (button darkens). | 30-cell change in the button; frame. | Done, brighter. | Save 2. | Harp plus vibraphone, resolving figure, brighter than save 1. | 0.6 s |
| 24.333 | Editor, rectangle and dim vanish (screenshot flash). | Whole-frame 445 889. | — | Nothing. | — | — |
| **24.617** | Dim + hover rectangle re-engage (24.617, 24.683, 24.733); thumbnail 2 lands in the sidebar inside this same window (its exact frame is masked by the overlay/zoom; 24.617–24.733). | Whole-frame changes; sidebar-only diff changes on 24.617/24.683/24.733. | Reward + aiming. | Thumbnail pop 2 and ready pedal 3 together. | Celesta high note at 24.617; viola held note ppp from 24.617 until 26.383. | 0.3 s / to 26.383 |
| 24.733 | ZOOM starts down-right to the chart card (ends 25.467). | 45-frame run. | — | — | — | — |
| 25.733–26.000 | Rectangle snaps onto the 7d / 14d / 30d control's row. | Frames. | — | — | — | — |
| **26.383** | CLICK 3: editor opens on the date-range control. | Editor on 26.383, absent 26.367. | Decision, lowest. | Placement 3; pedal stops. | Pizzicato cello, one low pluck (third voicing). | 0.4 s |
| 26.450 | Textarea focus ring on. | Frame. | — | — | — | — |
| **27.167** | Typing 3 begins ("f"). Message: "fix padding", 11 characters. | Diff 27.150→27.167 replaces the placeholder; "f" visible on 27.183. | Brisk. | Typing 3. | Marimba / kalimba, repeated notes, low-mid, the driest of the three. | 0.65 s |
| 27.817 | Typing 3 ends ("g"). | Diff 27.800→27.817 at caret. | — | — | — | — |
| 28.000–28.450 | Cursor to save; hover highlight 28.467 (transitions 28.533, 28.583). | Motion; diffs in the button box. | — | Silence. | — | — |
| **29.700 ●** | SAVE 3 press (textarea blurs; button darkens 29.717). | Diff 29.683→29.700 = editor outline; 29.717 button. | The fullest "done". | Save 3: small cadence. | Piano plus strings, the fullest of the three saves. | 0.8 s |
| 29.767 | Editor, rectangle and dim vanish (screenshot flash). | Whole-frame 341 643. | — | Nothing. | — | — |
| **29.883** | Thumbnail 3 lands ("this page (3)"). | Right-quarter 22 597; frame. | Three in the bag. | Thumbnail pop 3. | Celesta, one high note, a step above pop 1. | 0.3 s |

### Act 4 — The flourish

| t | On screen | Determined by | Feeling | Sound's job | Instrument / gesture | Len |
|---|---|---|---|---|---|---|
| 30.450–30.633 | Cursor crosses the chart toward the sidebar (arrow). | Motion. | — | Silence. | — | — |
| 30.650 | Dim + hover rectangle appear again as the cursor passes over the page (30.650, 30.700, 30.767; the rectangle snaps to cards 30.817–30.933). | Whole-frame changes. | Still armed. | Ready pedal 4, thin and high, uneasy; it will be cut by the switch-off. | Violin harmonic, one held note, ppp. | to 31.167 |
| 30.983 | ZOOM IN starts toward the sidebar switch (ends 31.800). | 50-frame run. | — | — | — | — |
| 31.167 | Dim overlay disappears (cursor enters the sidebar) mid-zoom. | Whole-frame 280 780. | — | Pedal fades out. | — | — |
| 32.300 | Switch press state. | 29-cell change. | — | — | — | — |
| **32.417 ●** | Switch flicks OFF: knob left, track dark (complete 32.467). | Frame 32.350 on, 32.417 off. | Tools down. | Switch off: the switch-on figure inverted. | Marimba, high-to-low two-note snap. | 0.35 s |
| 32.467 | ZOOM OUT to full frame (ends 33.350). | 54-frame run. | Breathing out. | Silence, or the faintest string swell into the sweep. | — | — |
| 33.400–33.800 | Cursor moves down into the list "this page (3)". | Motion. | — | — | — | — |
| **33.817** | Thumbnail 1 begins to magnify (dock effect; full by ≈33.933–34.050; the neighbours shift down). | Right-quarter changes 33.817–34.233, bbox y 0.31–0.65. | Elegance. | Sweep note 1 (start of the most beautiful passage). | Harp, a delicate arpeggio fragment; strings enter underneath, sustained and warm, growing through the sweep. | 0.5 s + strings |
| **34.417** | Thumbnail 2 magnifies (1 shrinks; full ≈34.583). | Right-quarter changes 34.300–34.700, bbox y 0.30–0.82. | — | Sweep note 2, a step lower (going down the list). | Harp. | 0.5 s |
| **34.817** | Thumbnail 3 magnifies (2 shrinks; full ≈35.000; held to 35.467). | Changes 34.767–35.050, bbox y 0.48–0.85. | — | Sweep note 3, lower again. | Harp. | 0.5 s |
| **35.583** | Thumbnail 2 magnifies again (3 shrinks; full ≈35.700): the cursor is coming back up. | Changes 35.467–35.750, bbox y 0.31–0.86. | — | Sweep note 4: the figure turns and rises. | Harp. | 0.5 s |
| **35.867** | Thumbnail 1 magnifies again (2 shrinks; full ≈36.050; held to ≈36.300). | Changes 35.767–36.233, bbox y 0.30–0.83. | — | Sweep note 5, top of the arch. | Harp. | 0.5 s |
| 36.300–36.567 | Cursor exits upward; thumbnail 1 shrinks; the list re-lays at 36.567. | Changes 36.300–36.567, bbox y 0.25–0.82. | Release. | Strings thin to a single high thread. | Violins, one held high note, pp, the only sound into Act 5. | to 38.150 |

### Act 5 — The close

| t | On screen | Determined by | Feeling | Sound's job | Instrument / gesture | Len |
|---|---|---|---|---|---|---|
| 36.583–37.100 | Cursor rises to the export (download) button. | Motion. | — | Thread holds. | — | — |
| 37.117 | ZOOM IN starts toward the export button (ends 37.850). | 45-frame run. | Tension by silence. | Nothing but the thread. | — | — |
| 37.867 | Cursor on the export button (hand). | Frame. | — | — | — | — |
| **38.150 ●** | EXPORT press: button background transitions 38.150–38.283. | Diffs confined to the button box 38.150–38.283. | The full stop. | Final chord, one decisive downbeat. | Full ensemble: low piano octave, strings, harp; struck together, then decaying. | ring to end |
| **38.500** | macOS Save dialog appears (effect of the click). | Whole-frame change 278 978; dialog visible. | Sealed. | One bell on top of the chord. | Celesta / harp harmonic, one high note. | 0.27 s to end |
| 38.767 | End of picture. | Duration. | — | Music ends here (trim the ring-out). | — | — |

Totals: 79 rows; 35 discrete event timestamps carry a note, 8 zoom starts and 8 zoom ends are logged as camera moves, 4 hover arrivals and 4 departures in Act 1.

---

## §3 Tempo map

Method: for every BPM from 60 to 160 in 0.1 steps and every grid origin in 5 ms steps, count how many of 19 "hard" events (menu open, app click, switch on/off, the three editor clicks, the three typing starts, the three saves, the three dim-engages, the reveal, the export press, the draw start) fall within ±35 ms (two frames) of an eighth-note grid.

Result: **a 391 ms pulse, grid origin 0.180 s.** Written as **77 BPM felt in 4 (quarter = 0.782 s), with the eighth note (0.391 s) as the placement grid.** (Numerically 76.7 BPM; the same grid read as 153.4 BPM quarters.) 15 of the 19 hard events sit on that eighth grid; across all 35 noted events, 15 sit within ±35 ms of an eighth (chance would give about 6) and 26 within ±35 ms of a sixteenth (chance about 13).

On the grid (residual from the nearest eighth):
save 1 press 17.000 (+1 ms) · typing 3 start 27.167 (−1) · sweep thumbnail 1 33.817 (−1) · click 3 26.383 (−3) · draw start 20.900 (−10) · dialog 38.500 (−11) · click 2 19.333 (−13) · typing 2 end 22.850 (−16) · draw end 21.283 (−18) · thumbnail 3 29.883 (−23) · switch on 10.717 (−24) · dim engages 2 18.200 (+28) · click 1 13.450 (−29) · export press 38.150 (+30) · sweep release 36.567 (+12).
On the sixteenth (±35 ms): app click 6.600 · reveal 8.167 · typing 1 end 16.050 · thumbnail 1 17.600 · save 2 24.267 · dim engages 3 24.617 · save 3 29.700 · switch off 32.417 · sweep 34.417, 34.817, 35.583.

Strays (nearest eighth, ms): menu opens 5.183 (−82) · sidebar 6.717 (+83) · typing 1 start 13.950 (+80) · dim engages 1 12.067 (−43) · textarea click 21.450 (−47) · typing 2 start 21.933 (+45) · typing 3 end 27.817 (+62) · dim engages 4 30.650 (−38) · sweep thumbnail 1 back 35.867 (+94). Handling: the grid is the composition's internal pulse, not a quantiser. A note that answers a hard visual (a menu popping open, a sidebar appearing) must sit on its frame regardless of the grid; a note that answers a soft or continuous visual (typing start, a pedal beginning, a fade) may be nudged up to ±80 ms onto the grid without any visible mismatch. Concretely: keep 5.183 and 6.717 on-frame (they are the arrival; no pulse is audible there anyway); move typing 1 start to 13.900 and typing 2 start to 21.900 if a quantised version is preferred; leave the pedals free (they are held notes, their onset is inaudible).

Act 1 is rubato: the three hover arrivals (1.383, 2.483, 3.233) do not sit on the grid and should not; the cello plays freely and the pulse starts with the first pluck at 5.183 (which is itself an anacrusis, 82 ms early to the grid). One tempo serves the whole film; no change between acts is needed. The sweep (33.817 → 35.867) reads as a five-note figure across roughly eighth–eighth–dotted-eighth–sixteenth spacings on this grid; treat it as a written-out rubato arpeggio rather than a strict rhythm.

---

## §4 Corrections to the director's narrative (the video wins)

1. **Four hovers, not three, and different targets.** The cursor rests on the page heading from frame 0 (the "redundant heading"), then visits "Add shipment" (mismatched button heights, 1.383), "SPOILGE RATE" (2.483) and the 7d / 14d / 30d date-range control that spills out of its card (3.233). The "Export CSV" text link is never hovered. The order is heading → buttons → typo → date picker. The spec scores the heading as a seed tone and the next three as the escalating triad.
2. **The extensions-icon click is invisible.** It happens under the zoom-in; its effect (the menu opening) is at 5.183. The salamander row shows a press state at 6.533 and the menu closes at 6.600.
3. **The sidebar does not animate in.** It appears complete in a single frame at 6.717; only the logo mark pops in 50 ms later (6.767). There is no slide to score; the "arrival" is an instant.
4. **The add-note button's two halves reveal at 8.167** when the cursor lands, as described. But the cursor then drifts across the button for two full seconds before the switch is flicked at 10.717; that gap is silence.
5. **Rectangles are not drawn; they are picked.** In add mode the page dims and a dashed rectangle snaps to whatever element the cursor is over (this dim + rectangle appears at 12.067, 18.200, 24.617 and again 30.650 when the cursor merely crosses the page). The "placement" click (13.450 / 19.333 / 26.383) opens the editor on the already-highlighted element. The dim overlay is a recurring event the brief did not mention; it is scored as a quiet held "ready" note that the click cuts.
6. **Second capture, the underline.** After the click (19.333) the cursor turns into a pencil at 19.633–19.650 without any visible click on the toolbar; the stroke runs 20.900–21.283; a click into the text box follows at 21.450; typing starts 21.933. So the order is click → (pencil) → draw → click text box → type → save.
7. **Third capture's target** is the 7d / 14d / 30d segmented date-range control ("fix padding"), which is the "date picker spilling out of its card" from the brief; noted here because it is the same element hovered at 3.233.
8. **Saves have three moments each**, not one: the press (17.000 / 24.267 / 29.700), a "screenshot flash" where editor, rectangle and dim vanish in one frame (17.433 / 24.333 / 29.767), and the thumbnail landing (17.600 / ≈24.617 masked / 29.883). Save 1's press also starts a zoom-out on the same frame.
9. **Typing is scripted**, not human: capture 1 is 30 characters in 2.10 s with two word-gaps, capture 2 is 12 characters in 0.92 s, capture 3 is 11 in 0.65 s. Voicing must vary because the durations already do.
10. **The flourish contains the switch-off**, which is preceded by a fourth dim overlay (30.650, cut at 31.167 when the cursor enters the sidebar) and a zoom to the switch. The sweep is continuous dock-magnification, not discrete pops: down 1 → 2 → 3 (33.817 / 34.417 / 34.817), pause on 3 until 35.467, back up 2 → 1 (35.583 / 35.867), exit at 36.567.
11. **The close is not just a click.** The export button's press state runs 38.150–38.283 and the macOS Save dialog appears at 38.500; the film ends at 38.767, 0.27 s after the dialog. The full stop therefore has two beats: the press and the dialog.
12. **Eight Cap zooms**, not "a zoom": listed in §1. One starts on a click frame (17.000, save 1), one 50 ms after the switch-off (32.467); the rest begin while the cursor is still travelling and are pure camera moves.

Things the frames cannot settle: the exact frame thumbnail 2 lands (24.617–24.733, masked by the overlay and the zoom); how the pencil tool was engaged (no visible click); the extensions-icon click frame (masked by the zoom, effect at 5.183); which single frame carries each keystroke inside the typing bursts (the 80×45 sampling grid misses single glyphs; burst start and end frames were confirmed by pixel diff).

---

## §5 The ElevenLabs prompt — one piece, 38.767 s

Paste as the text prompt; set the length to 38.8 s (38 767 ms). Count: under 4 000 characters.

```
Solo-instrument film score, 38.8 seconds, no beat, no pad, no synths, no vocals, mostly silence. Real instruments only: solo cello, viola, violins, felt piano, harp, celesta, marimba, clarinet, pizzicato double bass, vibraphone. Every sound is a single note or a two-to-five-note gesture placed at an exact second; between them, true silence. Pulse 77 BPM felt in 4 from 5.2s (eighth = 0.39s), rubato before that. Restrained, precise, expensive, like an Apple product film. Do not prescribe a key; think movement: tension, release, register, density.

0.0-4.8 THE PROBLEM, rubato. 0.0: one soft low cello note, no vibrato, fading by 0.8. Silence. 1.4: short bowed cello note with a second voice rubbing a hair off it, sour, unresolved, 0.4s. Silence. 2.5: higher, scraped, shorter, 0.3s. Silence. 3.2: highest, pressed then choked, a thin tail hanging. The three notes climb and never resolve. 4.8: a quiet upward cello harmonic swell, 0.7s.

4.8-7.5 THE ARRIVAL. 5.2: one dry pizzicato double-bass pluck. 6.6: one mid harp pluck, brighter. 6.7: THE PIVOT, a warm open piano chord with a string swell rising into it, bright and hopeful, the first time two instruments sound together; 6.8: one high celesta note sparkles on top. Chord rings out to 9.5. Nothing else.

7.5-29.9 THE WORK, sparse and rhythmic, silence between gestures. 8.2: light two-note upward piano figure, like a question. Silence. 10.7: marimba, crisp low-to-high two-note snap. Silence until 12.1: a single ppp viola note held; 13.45: firm mid piano note cuts it. 13.95-16.05: felt piano, soft repeated single notes 8-10 per second in short bursts, quiet as rain. 17.0: piano and soft vibraphone, two-note resolving figure. 17.6: one high celesta note. Silence. 18.2: ppp cello note held; 19.33: one harp pluck cuts it. 20.9-21.3: clarinet, one gliding note rising gently and wavering, 0.4s. 21.9-22.85: celesta music-box repeated notes, higher and lighter. 24.27: harp and vibraphone resolving figure, brighter. 24.6: high celesta note, then a ppp viola note held; 26.38: one low pizzicato cello pluck cuts it. 27.17-27.8: marimba repeated notes, low-mid, dry. 29.7: piano and strings, a small cadence, the fullest save. 29.9: one high celesta note, a step above the first.

29.9-36.6 THE FLOURISH. 30.65: a thin high violin harmonic held; it fades at 31.2. 32.4: marimba, high-to-low two-note snap, the earlier snap inverted. Silence. 33.8-35.9: the most beautiful passage: five delicate harp notes at 33.8, 34.4, 34.8, 35.6, 35.9 stepping down then turning back up, an arch; warm sustained strings enter under the first note and grow through the arch. 36.3-36.6: strings thin to a single high violin thread, pp, held alone.

36.6-38.8 THE CLOSE. Only the violin thread, tension by silence. 38.15: full stop: low piano octave, strings and harp struck together on one decisive downbeat, then decaying. 38.5: one high celesta bell on top. Ring out; end by 38.8.
```

If the tool offers a "composition plan" or section list, map its sections to the five act blocks above with these boundaries: 0.0 / 4.8 / 7.5 / 29.9 / 36.6 / 38.8.

---

## §6 Fallback — per-act prompts (use only if the single piece cannot hold its timing)

Which acts are worth splitting: **Act 3 (The work)** is the long one and the one most likely to drift; generate it alone with the events restated relative to a 0 s start. **Acts 4 + 5 (flourish + close)** are the second candidate because the sweep and the final chord are the only phrases where several instruments overlap; a separate render lets you time the arch precisely. **Acts 1 + 2** are short and mostly silence; generate them together, or not at all (the cello notes in Act 1 can be five individual sound-effect renders placed by hand, see §7).

Each fallback piece is generated with 1.0 s of leading silence so the first note has room, and the times inside the prompt are stated from the piece's own 0.0.

Part A — Acts 1 + 2, 8.5 s, place so its 1.0 s mark = film 0.000 (piece 0.0 s = film −1.0 s):

```
Solo-instrument film score, 8.5 seconds, no beat, no pad, no synths, no vocals, real instruments only, mostly silence. Rubato, then a pulse of 77 BPM from 6.2s. Restrained and precise, Apple product film.
0.0-1.0: silence. 1.0: one soft low cello note, no vibrato, fading by 1.8. Silence. 2.4: short bowed cello note with a second voice rubbing a hair off it, sour, unresolved, 0.4s. Silence. 3.5: higher, scraped, shorter, 0.3s. Silence. 4.2: highest, pressed then choked, a thin tail hanging; the three notes climb and never resolve. 5.8: quiet upward cello harmonic swell, 0.7s. 6.2: one dry pizzicato double-bass pluck. 7.6: one mid harp pluck, brighter. 7.7: a warm open piano chord with a string swell rising into it, bright and hopeful, the first time two instruments sound together; 7.8: one high celesta note on top. Let the chord ring to the end.
```

Part B — Act 3, 23.5 s, place so its 1.0 s mark = film 7.467:

```
Solo-instrument film score, 23.5 seconds, no beat, no pad, no synths, no vocals, real instruments only, silence between gestures. Pulse 77 BPM felt in 4 (eighth = 0.39s). Restrained, precise, productive, Apple product film. Vary the voicing across three repeated work cycles.
0.0-1.7: silence. 1.7: light two-note upward piano figure, like a question. Silence. 4.25: marimba, crisp low-to-high two-note snap. Silence until 5.6: a single ppp viola note held; 7.0: a firm mid piano note cuts it. 7.5-9.6: felt piano, soft repeated single notes 8-10 per second in short bursts, quiet as rain. 10.5: piano and soft vibraphone, two-note resolving figure. 11.1: one high celesta note. Silence. 11.7: ppp cello note held; 12.85: one harp pluck cuts it. 14.4-14.8: clarinet, one gliding note rising gently and wavering. 15.45-16.4: celesta music-box repeated notes, higher and lighter. 17.8: harp and vibraphone resolving figure, brighter. 18.15: high celesta note, then a ppp viola note held; 19.9: one low pizzicato cello pluck cuts it. 20.7-21.35: marimba repeated notes, low-mid, dry. 23.2: piano and strings, a small cadence, the fullest moment. 23.4: one high celesta note, a step above the first. End.
```

Part C — Acts 4 + 5, 9.9 s, place so its 1.0 s mark = film 29.883:

```
Solo-instrument film score, 9.9 seconds, no beat, no pad, no synths, no vocals, real instruments only. Pulse 77 BPM felt in 4. Elegant, then a full stop. Apple product film.
0.0-1.75: silence. 1.75: a thin high violin harmonic held; it fades at 2.3. 3.5: marimba, high-to-low two-note snap. Silence. 4.9-7.0: the most beautiful passage: five delicate harp notes at 4.9, 5.5, 5.9, 6.7, 7.0 stepping down then turning back up, an arch; warm sustained strings enter under the first note and grow through the arch. 7.4-7.7: strings thin to a single high violin thread, pp, held alone; tension by silence. 9.25: full stop: low piano octave, strings and harp struck together on one decisive downbeat, then decaying. 9.6: one high celesta bell on top. Ring out to the end.
```

Individual effect renders (ElevenLabs sound-effects, one per line, 0.3–0.8 s each, used only to patch a note the music render missed; place at the §2 timestamp):
- error hover cello: `single short bowed cello note, sour, unresolved, a second voice rubbing a hair off it, close mic, dry, 0.4 seconds` (1.383, 2.483 higher, 3.233 highest and choked)
- menu click: `one dry pizzicato double bass pluck, low, close mic, 0.3 seconds` (5.183)
- app click: `one harp pluck, mid register, bright, dry, 0.3 seconds` (6.600)
- switch on / off: `marimba two-note snap, low then high, crisp, dry, 0.35 seconds` (10.717) / `marimba two-note snap, high then low, crisp, dry` (32.417)
- placement: `one felt piano note, mid register, soft attack, 0.5 seconds` (13.450) / `one harp pluck` (19.333) / `one pizzicato cello pluck, low` (26.383)
- drawing: `clarinet, one sustained note gliding gently upward and wavering, 0.4 seconds, then lifting off` (20.900)
- save: `felt piano and soft vibraphone, two-note resolving figure, warm, 0.6 seconds` (17.000; harp+vibraphone 24.267; piano+strings small cadence 29.700)
- thumbnail pop: `one high celesta note, 0.3 seconds` (17.600, 24.617, 29.883)
- sweep: `harp, five delicate notes stepping down then back up, an arch, 2.2 seconds` (33.817)
- export: `low piano octave with strings and harp struck together, one decisive chord, decaying, 1.0 second` (38.150) + `one high celesta bell` (38.500)

---

## §7 Assembly guide

1. **Generate the single piece first** (§5). Render 2–3 takes; ElevenLabs will not hit every timestamp, but because the piece is mostly silence every note is an isolated island and can be moved.
2. **Slice at the silences.** Import the render into the DAW at 0.000 against picture. Add markers from the bold rows of §2. Cut the render wherever the waveform is silent (it will be, between gestures) and slide each island so its onset sits on its marker. Onsets go on the frame given; the only exceptions are the soft events in §3 where ±80 ms is allowed. Attack-first sounds (plucks, marimba, piano) align by their transient; bowed/held sounds (pedals, the violin thread) align by the frame the visual starts and fade in over 50 ms if the render's onset is abrupt.
3. **Check the seven anchors** before anything else: 5.183 bass pluck, 6.717 bloom, 10.717 snap, 13.450 / 19.333 / 26.383 placements, 38.150 final chord. If these are right the film already works; everything else is polish.
4. **Pedals and the violin thread** must stop on their cut frame (13.450, 19.333, 26.383, 31.167, 38.150). If the render lets them ring, fade them out over 30 ms at the cut.
5. **Typing bursts** (13.950–16.050, 21.933–22.850, 27.167–27.817): if the render's repeated notes do not fit the window, time-stretch is acceptable up to ±15 %; beyond that, re-render Act 3 (§6 Part B) or use the typing note as a one-shot and repeat it by hand at the burst boundaries given in §2.
6. **The drawing glide** (20.900–21.283) is 0.38 s; trim to length, fade the tail 40 ms after 21.283.
7. **The sweep arch** (33.817 / 34.417 / 34.817 / 35.583 / 35.867): the five harp notes go on the frames; the string swell under them starts at 33.817 and thins at 36.300, leaving one held note to 38.150. If the render's arch is too compressed, this is the passage to regenerate separately (§6 Part C).
8. **The close**: chord onset at 38.150, bell at 38.500, hard end at 38.767 with a 100 ms fade so the ring-out does not run past picture. If a longer tail is wanted, extend the picture's last frame, not the audio.
9. **If the single piece drifts** more than a second somewhere, do not fight it: generate the offending act with the §6 prompt (Part A/B/C), place it by its 1.0 s lead-in mark, and cross-fade to the main render in the nearest silence (there is always one within two seconds).
10. **Patching** a single missing or wrong note: render it as a sound effect from the §6 list and drop it on the frame; match loudness to its neighbours (all of this piece sits around −24 to −18 LUFS short-term, peaks no higher than −6 dBTP; the final chord may peak at −3 dBTP).
11. **Silence is a tool**: do not fill the gaps (0.8–1.4, 7.5–8.2, 8.4–10.6, 10.9–12.0, 36.6–38.15 and every gap inside Act 3). No room tone, no bed. The film's own silence is the negative space the notes need.
12. Deliverables: one 48 kHz / 24-bit stereo WAV, 38.767 s, starting at 0.000, plus the DAW session with the §2 markers so the mix can be re-timed if the picture is re-cut.
