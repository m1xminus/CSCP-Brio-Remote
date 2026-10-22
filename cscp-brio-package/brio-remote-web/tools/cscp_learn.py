#!/usr/bin/env python3
"""
cscp_learn.py - guided, LISTEN-ONLY recorder: teach it one desk action at a time.

  1. It connects, waits for the desk's start-up dump to finish, and records a few
     seconds of idle "background" traffic.
  2. You type a name for the action (e.g.  fader 3 movement) and press Enter.
     Recording starts.
  3. Do the action on the desk, then press Enter again. Recording stops and it
     prints what the desk reported.
  4. It asks for the next action. Type  done  (or just press Enter on an empty
     name) to finish; it then writes the JSON file.

Nothing is sent to the desk except a console-info read at the start and every
few seconds as a keep-alive (the same request the main app uses).

  python cscp_learn.py 192.168.0.10 --port 49200

Output: learn_<date>_<time>.json (send it to me). Python 3.8+, standard library only.
"""
import argparse, json, socket, threading, time

SOH, ACK, NAK = 0xF1, 0x04, 0x05
KNOWN = {
    0x0000: "fader level", 0x0001: "fader cut", 0x0002: "main level", 0x0005: "fader PFL",
    0x0007: "name", 0x0008: "console info", 0x000B: "fader label", 0x000C: "main PFL",
    0x000D: "main label", 0x0010: "available aux", 0x0011: "assignment", 0x0012: "aux send on/off",
    0x0013: "aux output level", 0x0014: "available mains", 0x0015: "route to main", 0x0016: "L>B / R>B",
}
KEEPALIVE = bytes([SOH, 2, 0, 0x00, 0x08, 0xF8])  # read console info (7.2)


def checksum(body):
    return (-sum(body)) & 0xFF


def u16(d, o=0):
    return (d[o] << 8) | d[o + 1] if len(d) >= o + 2 else None


def describe(cmd, d):
    c = cmd & 0x7FFF
    if c == 0x0000 and len(d) >= 4: return f"fader {u16(d)} level {u16(d, 2)}"
    if c == 0x0001 and len(d) >= 3: return f"fader {u16(d)} {'CUT' if d[2] == 0 else 'on'}"
    if c == 0x0005 and len(d) >= 3: return f"fader {u16(d)} PFL {'on' if d[2] else 'off'}"
    if c == 0x0002 and len(d) >= 4: return f"main {u16(d)} level {u16(d, 2)}"
    if c == 0x000C and len(d) >= 3: return f"main {u16(d)} PFL {'on' if d[2] else 'off'}"
    if c == 0x000B and len(d) >= 2: return f"fader {u16(d)} label {d[2:].decode('ascii', 'replace')!r}"
    if c == 0x0013 and len(d) >= 4: return f"aux {u16(d)} output level {u16(d, 2)}"
    if c == 0x0012 and len(d) >= 1: return f"aux {d[0]} send bitmap {d[1:].hex()}"
    if c == 0x0015 and len(d) >= 1: return f"main {d[0]} route bitmap {d[1:].hex()}"
    return ""


class Recorder(threading.Thread):
    """Reads the socket in the background and stores every message with a timestamp."""

    def __init__(self, sock, keepalive):
        super().__init__(daemon=True)
        self.s, self.keepalive = sock, keepalive
        self.msgs, self.lock, self.closed = [], threading.Lock(), False
        self.t0 = time.monotonic()

    def now(self):
        return round(time.monotonic() - self.t0, 3)

    def add(self, kind, **kw):
        with self.lock:
            self.msgs.append({"t": self.now(), "kind": kind, **kw})

    def since(self, t):
        with self.lock:
            return [m for m in self.msgs if m["t"] >= t]

    def last_t(self):
        with self.lock:
            return self.msgs[-1]["t"] if self.msgs else 0

    def run(self):
        buf, last_ka = bytearray(), time.monotonic()
        while not self.closed:
            if self.keepalive and time.monotonic() - last_ka > self.keepalive:
                try: self.s.sendall(KEEPALIVE)
                except OSError: self.closed = True; break
                last_ka = time.monotonic()
            try:
                d = self.s.recv(4096)
                if not d: self.add("closed"); self.closed = True; break
                buf += d
            except socket.timeout:
                continue
            except OSError:
                self.closed = True; break
            i = 0
            while i < len(buf):
                c = buf[i]
                if c == ACK: i += 1; continue
                if c == NAK:
                    if i + 1 >= len(buf): break
                    self.add("nak", nak=buf[i + 1]); i += 2; continue
                if c != SOH: i += 1; continue
                if i + 1 >= len(buf): break
                bc = buf[i + 1]
                if not 2 <= bc <= 50: i += 1; continue
                if i + 4 + bc > len(buf): break
                body = bytes(buf[i + 3:i + 3 + bc])
                if checksum(body) != buf[i + 3 + bc]: i += 1; continue
                cmd, data = (body[0] << 8) | body[1], body[2:]
                i += 4 + bc
                base = cmd & 0x7FFF
                if base == 0x0008:  # keep-alive reply: not interesting
                    continue
                self.add("msg", cmd=cmd, base=base, known=KNOWN.get(base), data=data.hex(),
                         text=describe(cmd, data))
            del buf[:i]


def summarise(msgs):
    out = {}
    for m in msgs:
        if m["kind"] != "msg": continue
        key = f"0x{m['base']:04X}"
        e = out.setdefault(key, {"name": m["known"] or "UNKNOWN (not in v22 doc)", "count": 0})
        e["count"] += 1
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("host"); ap.add_argument("--port", type=int, default=49200)
    ap.add_argument("--keepalive", type=float, default=5.0)
    ap.add_argument("--idle", type=float, default=4.0, help="seconds of background recording at the start")
    ap.add_argument("--startup-wait", type=float, default=30.0, help="max seconds to wait for the start-up dump")
    ap.add_argument("--out", default=time.strftime("learn_%Y%m%d_%H%M.json"))
    a = ap.parse_args()

    s = socket.create_connection((a.host, a.port), timeout=5)
    s.settimeout(0.2)
    s.sendall(KEEPALIVE)
    rec = Recorder(s, a.keepalive)
    rec.start()
    print(f"Connected to {a.host}:{a.port}. Waiting for the desk's start-up dump...")
    t_start = time.monotonic()
    while time.monotonic() - t_start < a.startup_wait:
        time.sleep(0.5)
        if rec.msgs and rec.now() - rec.last_t() > 2.0: break
    print(f"  received {len(rec.msgs)} messages. Recording {a.idle:.0f} s of background (don't touch the desk)...")
    t_bg = rec.now(); time.sleep(a.idle)
    background = rec.since(t_bg)
    bg_sum = summarise(background)
    print(f"  background: {sum(v['count'] for v in bg_sum.values())} messages "
          + (", ".join(f"{k} x{v['count']}" for k, v in bg_sum.items()) or "(quiet)"))

    actions = []
    print("\nReady. Type a name for the action and press Enter to START recording,")
    print("do it on the desk, then press Enter again to STOP. Type  done  to finish.\n")
    try:
        while not rec.closed:
            name = input("Action name (or 'done'): ").strip()
            if name.lower() in ("", "done", "d", "q", "quit", "exit"):
                break
            t0 = rec.now()
            input(f"  ● RECORDING '{name}' - do it now, press Enter when finished... ")
            t1 = rec.now()
            msgs = [m for m in rec.since(t0) if m["t"] <= t1]
            summ = summarise(msgs)
            actions.append({"action": name, "start": t0, "end": t1, "summary": summ, "messages": msgs})
            if not summ:
                print("  → NOTHING reported by the desk (CSCP does not expose this, or it needs another move).")
            for k, v in summ.items():
                print(f"  → {k} {v['name']}: {v['count']} message(s)")
            unknown = [m for m in msgs if m["kind"] == "msg" and not m["known"]]
            for m in unknown[:5]:
                print(f"     UNKNOWN 0x{m['cmd']:04X} data={m['data']}")
            print()
    except (KeyboardInterrupt, EOFError):
        print("\n(stopped)")
    rec.closed = True

    unknown_all = sorted({f"0x{m['base']:04X}" for act in actions for m in act["messages"]
                          if m["kind"] == "msg" and not m["known"]})
    result = {"desk": f"{a.host}:{a.port}", "recorded": time.strftime("%Y-%m-%d %H:%M:%S"),
              "background": bg_sum, "unknown_commands_seen": unknown_all, "actions": actions}
    with open(a.out, "w") as f:
        json.dump(result, f, indent=1)
    print(f"\nSaved {len(actions)} action(s) to {a.out}")
    print("Unknown commands: " + (", ".join(unknown_all) if unknown_all else "none - everything you did is in the documented set"))


if __name__ == "__main__":
    main()
