# Calrec Brio (CSCP)

Controls a Calrec Brio over its remote-control protocol (CSCP).

## Set up

1. On the desk, enable remote control (*External Controls*) and make sure it has a CSCP TCP port.
2. The computer running Companion needs an address in the desk's network (for example desk `192.168.0.10`, computer `192.168.0.11`, mask `255.255.255.0`).
3. Add the connection, enter the desk's IP address and the CSCP port.

Brio defaults: **36 surface faders**, **1 layer**. Faders are named like the desk: `A1` ... `A36` and `B1` ... `B36`.

## Presets: pick one, choose the source

Open the **Presets** tab of this connection. Drag a button out, then open its **local variables** (at the top of the button editor) and change the source:

| Local variable | Example |
|---|---|
| `fader` | `A8`, `B12` |
| `group` | `A11` (the fader name of the group or VCA master) |
| `main` | `1` |
| `aux` | `3` |

The action, the colour feedback and the button text all follow that one value.
Under each section there are also groups that create **one button per fader / main / aux** at once.

Faders, groups, mains and aux masters get the same set of buttons:

| Section | Buttons |
|---|---|
| Fader | cut / on (with level and an encoder), level up, level down, set level, **open** (uncut + fade up), **close** (fade down + cut), PFL |
| Group / VCA | the same, for group faders and VCA masters. The list of groups is what the desk reports |
| Main | cut / on, level up / down, set level, **open** / **close** (fade), PFL |
| Aux master | cut / on, level up / down, set level, **open** / **close** (fade). No PFL: CSCP has none for aux masters |
| Routing | fader to aux send on / off, fader to main on / off, stereo L>B / R>B |
| Desk | connection status |

**Main and aux master "cut / on" work on the level.** CSCP has no cut for mains or aux masters, so *cut* drops the level to off and remembers it, *on* puts it back. If Companion restarts while cut, *on* returns to 0 dB / unity.

## Actions

Fader: set level, step, open, close, cut / on, PFL. Group / VCA: the same six, with a picker that lists only groups. Main: set level, step, open, close, cut / on, PFL. Aux master: set level, step, open, close, cut / on. Aux send on / off, route to main on / off, L>B / R>B.
Level actions take dB and an optional **fade time**. Fades move the fader like a hand would and are limited to 10 updates per second per fader, which is what the desk accepts. A new command on the same fader replaces a fade that is still running.

## Feedbacks

Fader and group / VCA: cut, open, PFL. Main: cut, open, PFL. Aux master: cut, open. Aux send on, routed to main, L>B / R>B, desk connected.

## Variables

`fader_A1_label`, `fader_A1_db`, `fader_A1_state` (CUT or ON) for every fader, `main_1_label`, `main_1_db`, `aux_1_db`, `desk_name`, `desk_status`, `desk_version`. Labels come from the desk.

## Starting things from other software (HTTP)

This connection answers simple URLs on Companion's own web server (default port 8000):

`http://<companion-ip>:8000/instance/<connection label>/...`

The connection label is the name shown in Companion's connection list (for example `brio`). Both GET and POST work.

| Example | What it does |
|---|---|
| `/fader/A8/open?db=0&fade=500` | un-cut fader A8 and fade it up to 0 dB over 500 ms |
| `/fader/A8/close?fade=1000` | fade down and cut |
| `/fader/A8/level?db=-10` | set the level |
| `/fader/A8/cut`, `/on`, `/toggle` | cut / on |
| `/fader/A8/pfl`, `/pfl/on`, `/pfl/off` | PFL |
| `/group/A11/open?db=0&fade=500` | the same urls for a group or VCA master (`/group/FX GRP/close`, `/cut`, `/level`, `/pfl` ...). Must really be a group |
| `/main/1/open?db=-10&fade=500`, `/main/1/close?fade=500` | fade a main up / down |
| `/main/1/level?db=-10`, `/main/1/off`, `/on`, `/pfl` | main |
| `/aux/1/open?db=0&fade=500`, `/aux/1/close` | fade an aux master up / down |
| `/aux/1/level?db=0`, `/aux/1/off`, `/on` | aux master |
| `/send/A8/2/on` | fader A8 to aux 2 on (`on`, `off`, `toggle`) |
| `/route/A8/1/on` | fader A8 to main 1 |
| `/fader/A8` | state of A8 (JSON) |
| `/status`, `/help` | connection state, list of urls |

You can also use the fader's **label on the desk** instead of `A8` (for example `/fader/MIC%201/open`).

**Example: a media player that opens a fader when a song starts.** Make the player call
`http://<companion-ip>:8000/instance/brio/fader/B3/open?db=-6&fade=300` when the song starts and `.../fader/B3/close?fade=1000` when it ends.

Companion's own button API also works (`POST http://<companion-ip>:8000/api/location/<page>/<row>/<column>/press`) if you would rather trigger a button you built.

Anyone who can reach Companion's web port can send these. Use it on a trusted network.

## What CSCP cannot do

No metering, no per-fader aux send level (only on / off), no gain, EQ, dynamics, pan, patching, snapshots, main cut or aux names. These are not in the protocol, so they are not in this module.

## Troubleshooting

- *Connecting / disconnected*: check the desk's remote control is on, the port, and that the computer can ping the desk.
- *Wrong fader moves*: check "Surface faders controlled over CSCP", "Layers" and "B layer off" in the connection settings.
- Turn on **Log every message** in the connection settings to see the traffic in the Companion log.
