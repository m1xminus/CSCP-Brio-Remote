Calrec Brio Remote (CSCP)

Control your Calrec Brio from a browser or a Stream Deck. This project talks to the desk over CSCP, Calrec’s own remote protocol, and comes in two parts that share the same core.

1. Web remote
A fader-bay screen that runs on your computer and opens in any browser, including a tablet on the same network. It shows the Brio’s 36 faders in three banks of 12, with layers A and B. You can:

Move faders by dragging them. Shift-drag is fine adjustment, and double-click sets unity.
Cut or turn on a channel, PFL it, and route it to the mains. Stereo strips also have L>B / R>B.
Switch to the Groups/VCA, Mains and Aux output pages.
Use “Sends on fader” mode. Pick an aux and every strip becomes an on/off pad for that aux send.
Lock the screen so nothing can be touched by accident.

The screen follows the desk. What you see is what the desk reports back, so moves made on the surface show up on the screen too.

2. Bitfocus Companion module
Puts the same control on Stream Deck or any Companion surface:

Ready-made preset buttons for faders, groups/VCA, mains and aux masters: level up/down, set level, cut/on, open, close and PFL. To point a button at another source, change one value on it, such as the fader name or the aux number.
Open and close are timed fades. A fader goes up from cut to your level, or down and then cut, over the time you choose.
HTTP triggers: any software that can call a URL can control the desk. For example, our BLAST media player can open a fader automatically when a song starts, and close it when the song ends.

What it can’t do
CSCP is limited by what Calrec exposes. There are no audio meters, no aux send levels (only on/off), and no gain, EQ, dynamics, patching or snapshots. Mains and aux masters have no cut in CSCP, so the module emulates it through the level.

Status: the protocol was checked against a real Brio, but test a spare fader before using it on air.

Want more detail? The root README.md explains exactly what can be controlled and how to set it up. brio-remote-web/README.md covers the web app, and companion-module-calrec-brio/companion/HELP.md covers the Companion module.

<img width="959" height="415" alt="Captura de ecrã 2026-10-22 105242" src="https://github.com/user-attachments/assets/1cd52134-ff3b-42f9-a254-fa44add76f91" />
<img width="959" height="407" alt="Captura de ecrã 2026-10-22 105229" src="https://github.com/user-attachments/assets/905477e2-35f4-4959-9632-697edb87c42c" />
<img width="959" height="413" alt="Captura de ecrã 2026-10-22 105219" src="https://github.com/user-attachments/assets/0ea4b917-6d1a-4e27-98e5-5cfc29534f58" />
<img width="959" height="413" alt="Captura de ecrã 2026-10-22 105210" src="https://github.com/user-attachments/assets/d18d3d57-0cbc-4b30-bcfc-352e22bc843e" />
<img width="959" height="413" alt="Captura de ecrã 2026-10-22 105124" src="https://github.com/user-attachments/assets/7ed2ec25-102c-48f8-b252-49b5b6314a6a" />
