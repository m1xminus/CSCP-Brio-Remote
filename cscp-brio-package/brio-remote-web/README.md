# CSCP Brio Remote

A remote-control GUI for the **Calrec Brio** over **CSCP** (Calrec Serial Control Protocol, v22 / rev 2.10).
It runs on your computer, talks to the desk over TCP, and shows a fader bay in the browser.
The protocol core is plain Node.js with no UI dependencies, and the Companion module reuses it.

> **Not yet tested on a real Brio.** Everything below was built against the Calrec document and a simulated
> desk. See [What is and isn't verified](#what-is-and-isnt-verified) before connecting it to a desk that is on air.

## Quick start

```bash
npm install
npm run demo                 # GUI + built-in simulated desk, http://127.0.0.1:8787
npm start -- --host 10.0.0.50 --desk-port 49200    # against a real desk
npm start                    # GUI only; enter the address in Settings
npm test                     # 58 tests
```

On the desk: remote control is **disabled by default**. Enable it on the console PC's *External Controls* page,
and make sure a `cscp_port` line exists in `StudioSetup` (the doc's example: `cscp_port = name1,49200,4,1`).
Which protocol number gives v22 on a Brio is unknown (the doc's list stops at 4 = v21), so check the version the
header shows after connecting.

By default the GUI is only reachable from this computer. `--listen 0.0.0.0` opens it to the LAN (for a tablet);
anyone who can reach the page can then move faders, so use a trusted network only.

## What the GUI does

Pick what you want to see with the selector at the top:

| View | Shows |
|---|---|
| **FADERS** | The Brio's 36 faders as three divisions of 12 (**1–12, 13–24, 25–36**) and two layers (**A / B**). Each strip: scribble label (colour by path type), route to mains (M1…), L>B / R>B on stereo strips, PFL, fader with dB scale, cut (or ON) |
| **GROUPS** | Every group and VCA master fader found on any layer, in one place (12 per page) |
| **MAINS** | Main faders + PFL (CSCP has no main cut) |
| **OUTPUTS** | Aux output master faders. The SENDS button on each jumps to that aux's sends |
| **AUX SENDS** | *Sends on fader*: pick an aux, and every strip becomes a big send **ON/OFF** pad for that aux. The aux's output master fader sits at the right. The tab, a banner and the strip edges **blink amber** so it is obvious you are in this mode |

Fader: drag, **Shift-drag** for fine, arrow keys (Shift = 1, Ctrl = 25), **double-click = unity**.
**Lock** blocks all control input. **Log** shows live traffic (optionally hex).
Banks follow the doc's protocol-fader allocation (section 6.1): with 36 controlled faders, layer A is protocol
faders #0–35 and layer B is #36–71. CSCP does not report the surface size, so *Surface faders controlled over CSCP*
(default 36), *Layers* (default 1; there is no layer selector unless you raise it) and *B layer off* are in Settings.
Each strip shows its surface position (1–12 per division); the tooltip gives the protocol fader number.
CSCP gives no group membership or VCA assignments, so GROUPS lists the master faders only.

**Limits that come from CSCP itself, not from this program**
- **No send levels.** CSCP only exposes the per-fader aux send *on/off* switch (7.12) and the aux *output* level
  (7.13). So "sends on fader" can switch sends but cannot show or set a send's level. Real send-level faders are
  not possible over this protocol.
- **No metering.** CSCP has no meter data, so there are no audio meters.
- Also not available: gain, EQ, dynamics, pan, patching, snapshots, main cut, **aux names** (there is no aux label command).

## Layout

```
src/core/     frame.js (framing, parser) · messages.js (17 typed commands) · client.js (TCP, reconnect,
              rate-limited coalescing queue) · mirror.js · desk.js (state mirror + echo-verified writes)
src/shared/   levels.js (level<->dB) · model.js (state, bitmaps, fader<->surface maths)  [Node + browser]
src/mock/     simulated desk for development and tests
src/server.js HTTP + WebSocket bridge          public/  the GUI
```

## What is and isn't verified

**Checked against the Calrec document**
- Frame format, checksum, `BC ≤ 50`, device bytes, and the worked example `F1 06 00 80 00 00 03 02 E8 93`.
- All command IDs and payload layouts 7.1–7.17, bitmap bit order, L>B/R>B bit pairing, console-info layout.
- Level curves against 30 rows of the appendix table (error ≤ 0.11 dB). One row in the doc (main, level 100) is a typo and is excluded.
- Protocol-fader ↔ surface allocation against the doc's example table, with and without B layer.
- Sender rate: never more than 3 frames in any 20 ms (measured with a high-resolution clock), plus the 10 values/s per-fader cap.

**Assumptions: please confirm on the real desk**
1. **NAK error bits.** The bit positions are in a figure that isn't in the text. A real Brio answered an unknown
   command with `0x40` and a wrong data length with `0x05`, which fits the doc's list read MSB-first
   (command-not-supported = bit 6 … protocol = bit 0). I use that now; the doc's figure would confirm it.
2. **Rate margin.** The doc quotes 3 messages / 20 ms, "confirmed" only for a Perle serial server. I enforce a
   25 ms window (about 120 msg/s) for safety margin. A full re-read of every fader takes roughly 10 s.
3. **Fader count and surface layout** of your Brio (see Settings).
4. **Cloned faders.** The doc says aux/route/L>B writes are applied fader-by-fader and the last one wins, so a
   clone can undo your switch. The GUI marks a *possible* clone (dashed amber border) when two faders share
   audio type and Calrec ID. The doc also calls the ID "not fully specified", so treat it as a hint.
5. **The simulated desk is my reading of the document**, not captured behaviour. In particular the way a main
   on a fader reports through both 7.3 and 7.7, timings (ACK ~3 ms, reply ~40 ms), and VCA examples.
   Once you have a real capture, replaying it is the better test.

**Before first use on a live desk:** use a spare fader first. Writes are real, and the GUI mirrors whatever the
desk echoes back, so what you see is the desk's state, not what you clicked.

## Companion module

The Bitfocus Companion module built on this protocol core lives next to this folder
(`../companion-module-calrec-brio`). See the README in the parent folder.

## Tests

`npm test`: protocol/unit (20), desk integration against the simulated desk (13), bridge server (7),
GUI behaviour in jsdom (17). The GUI layout and the blinking sends mode were checked in headless Chromium with real mouse
input (drag, click) against the demo desk.
