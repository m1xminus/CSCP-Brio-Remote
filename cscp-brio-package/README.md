# Calrec Brio remote control (CSCP)

Two ways to control a **Calrec Brio** over its remote protocol, **CSCP** (Calrec Serial Control Protocol), sharing one protocol core:

| Folder | What it is | Use it for |
|---|---|---|
| `brio-remote-web/` | A fader-bay web GUI. Runs on your computer, opens in a browser | Looking at and moving the desk from a PC or tablet |
| `companion-module-calrec-brio/` | A **Bitfocus Companion** module (v0.2.0, ready-to-import `calrec-brio-0.2.0.tgz` inside) | Stream Deck / button pages, and **HTTP triggers** (for example BLAST opening a fader when a song starts) |

> **Status:** protocol checks (framing, command layouts, NAK codes, fader numbering) were verified against a real Brio.
> Everything else was tested against a simulated desk only. **Try it on a spare fader before using it on air.**

---

## What can be controlled

This is everything CSCP exposes. Nothing more can be done from software, whatever the program.

| Thing | Level | Cut / On | PFL | Open / close (fade) | Other |
|---|---|---|---|---|---|
| **Faders** (up to 36 per layer, layers A/B) | yes | yes | yes | module only | route to mains, L>B / R>B (stereo), aux send on/off |
| **Groups / VCA masters** | yes | yes | yes | module only | listed automatically by the desk's fader type |
| **Mains** (Brio: 2 configured) | yes | module only (done with level) | yes | module only | |
| **Aux masters** (Brio: 12 available) | yes | module only (done with level) | no | module only | per-fader aux send on/off |

Notes:
- **Open** = uncut and fade up to a level over a time. **Close** = fade down, then cut. Fades are done in 100 ms steps (the desk allows 10 updates per second per fader).
- Mains and aux masters have no cut in CSCP. The module's "cut" sets their level to off and remembers it; "on" restores it.
- Fader names are the ones on the desk: `A1`..`A36`, `B1`..`B36` (layer 1). `p12` means protocol fader 12.
- Mains and aux are numbered from 1.

**Not possible over CSCP (the desk does not offer it):** audio meters, aux **send levels** (only send on/off), gain, EQ, dynamics, pan, patching, snapshots, main cut, aux master cut/PFL, aux names.
We scanned a real Brio for hidden commands and found none beyond the 16 documented ones.

---

## What you need to do

### 1. On the desk (once)
1. Enable remote control on the console PC's *External Controls* page (disabled by default).
2. Make sure a CSCP TCP port is set in `StudioSetup` (Calrec's example: `cscp_port = name1,49200,4,1`).
3. Put the computer on the same network as the desk and check you can ping it. Note the desk's IP address and the port.

### 2a. The web GUI (`brio-remote-web/`)
Needs [Node.js](https://nodejs.org) 18 or newer.

```
cd brio-remote-web
npm install
npm start -- --host <desk IP> --desk-port 49200
```
Open **http://127.0.0.1:8787**. Try it without a desk first with `npm run demo`.
To reach it from a tablet add `--listen 0.0.0.0` (anyone on the network can then move faders, so only on a trusted network).

In the GUI: choose **FADERS / GROUPS / MAINS / OUTPUTS / AUX SENDS** at the top. Drag a fader (Shift = fine, double-click = unity), use CUT, PFL, route and aux buttons. **Lock** blocks all input. Set *Surface faders controlled over CSCP* in Settings if your desk is not using 36. Details are in `brio-remote-web/README.md`.

### 2b. The Companion module (`companion-module-calrec-brio/`)
Needs Bitfocus Companion 5.0 or newer.
1. In Companion open the **Modules** page and import **`calrec-brio-0.2.0.tgz`** (in the module folder).
2. Add a **Calrec Brio** connection. Enter the desk IP and the CSCP port.
3. Open the connection's **Presets** tab and drag buttons out. Each preset button has a local variable for its source: `fader` (`A8`), `group`, `main` (`1`) or `aux` (`3`). Change that one value to point the button at another source.
4. Presets exist for level, cut/on, open, close and PFL on faders, groups, mains and aux masters, plus aux send, route to main, L>B / R>B and desk status.
5. Actions, feedbacks and variables are also available for building your own buttons.

**HTTP triggers (for BLAST [https://blast.machadrade.uk] or anything that can call a URL).** Use Companion's web port (default 8000):
```
http://<companion-ip>:8000/instance/<connection label>/fader/B3/open?db=-6&fade=300
http://<companion-ip>:8000/instance/<connection label>/fader/B3/close?fade=1000
```
The same shape works for `group/<name>`, `main/<n>` and `aux/<n>`; see `/help` on the same address for the full list. Anyone who can reach Companion's port can send these, so keep it on a trusted network.

Full module documentation: `companion-module-calrec-brio/companion/HELP.md`.

---

## Other contents
- `brio-remote-web/tools/` Python helpers used to test against the real desk: `cscp_watch.py` (listen-only monitor), `cscp_learn.py` (record what a desk action sends), `cscp_probe.py` (read-only command scanner; run it slowly, it does not change anything).
- Both folders have their own tests (`npm test`). I have run both and the findings are documented here, but feel free to try it yourself.
- `companion-module-calrec-brio/src/lib` is a copy of the protocol core from `brio-remote-web/src`.