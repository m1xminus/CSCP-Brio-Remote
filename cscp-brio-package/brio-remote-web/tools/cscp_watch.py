#!/usr/bin/env python3
"""
cscp_watch.py - LISTEN-ONLY CSCP monitor. Touch the desk, see what it reports.

Connects to the desk, sends one harmless read (console info) to start the
unsolicited-update stream, then just prints every message the desk sends
(plus a short keep-alive read every few seconds). Nothing else is ever sent.

Use it to find out which controls the desk reports over CSCP, and whether any
report a command number that is NOT in the v22 document:

  python cscp_watch.py 192.168.0.10 --port 49200

While it runs, type a note and press Enter (e.g. "moved fader 3 up") to put a
marker line in the log, so you can match actions to messages afterwards.
Touching a control and seeing NOTHING means CSCP does not report it.
Output is also saved to watch_<date>_<time>.log / .jsonl.   Ctrl-C to stop.
Python 3.8+, standard library only.
"""
import argparse, json, socket, sys, threading, time

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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("host"); ap.add_argument("--port", type=int, default=49200)
    ap.add_argument("--keepalive", type=float, default=5.0, help="seconds between keep-alive reads (0 = off)")
    ap.add_argument("--show-keepalive", action="store_true", help="also print the replies to the keep-alive")
    a = ap.parse_args()

    stamp = time.strftime("%Y%m%d_%H%M")
    txt, jl = open(f"watch_{stamp}.log", "w"), open(f"watch_{stamp}.jsonl", "w")
    t0 = time.monotonic()
    lock = threading.Lock()

    def emit(kind, line, rec):
        ts = time.monotonic() - t0
        out = f"[{ts:8.3f}] {kind:8} {line}"
        with lock:
            print(out); txt.write(out + "\n"); txt.flush()
            jl.write(json.dumps({"t": round(ts, 3), "kind": kind, **rec}) + "\n"); jl.flush()

    s = socket.create_connection((a.host, a.port), timeout=5)
    s.settimeout(0.2)
    s.sendall(KEEPALIVE)
    print(f"connected to {a.host}:{a.port}. Touch faders / buttons. Type a note + Enter to add a marker. Ctrl-C to stop.")

    def notes():
        for line in sys.stdin:
            emit("NOTE", line.strip(), {"note": line.strip()})
    threading.Thread(target=notes, daemon=True).start()

    buf, last_ka, seen = bytearray(), time.monotonic(), {}
    try:
        while True:
            if a.keepalive and time.monotonic() - last_ka > a.keepalive:
                s.sendall(KEEPALIVE); last_ka = time.monotonic()
            try:
                d = s.recv(4096)
                if not d: emit("CLOSED", "desk closed the connection", {}); break
                buf += d
            except socket.timeout:
                pass
            i = 0
            while i < len(buf):
                c = buf[i]
                if c == ACK: i += 1; continue
                if c == NAK:
                    if i + 1 >= len(buf): break
                    emit("NAK", f"error byte 0x{buf[i+1]:02X}", {"nak": buf[i + 1]}); i += 2; continue
                if c != SOH: emit("JUNK", f"byte 0x{c:02X}", {"byte": c}); i += 1; continue
                if i + 1 >= len(buf): break
                bc = buf[i + 1]
                if not 2 <= bc <= 50: i += 1; continue
                if i + 4 + bc > len(buf): break
                body = bytes(buf[i + 3:i + 3 + bc])
                if checksum(body) != buf[i + 3 + bc]: emit("BADCS", body.hex(), {"hex": body.hex()}); i += 1; continue
                cmd, data = (body[0] << 8) | body[1], body[2:]
                i += 4 + bc
                base = cmd & 0x7FFF
                if base == 0x0008 and not a.show_keepalive:
                    continue
                known = KNOWN.get(base)
                if known:
                    emit("known", f"0x{cmd:04X} {known:16} {describe(cmd, data) or data.hex()}", {"cmd": cmd, "data": data.hex()})
                else:
                    seen[base] = seen.get(base, 0) + 1
                    emit("UNKNOWN", f"0x{cmd:04X} data={data.hex()}  <-- NOT IN THE v22 DOCUMENT", {"cmd": cmd, "data": data.hex()})
            del buf[:i]
    except KeyboardInterrupt:
        pass
    print("\nstopped.")
    if seen: print("Unknown command numbers seen:", ", ".join(f"0x{k:04X} x{v}" for k, v in sorted(seen.items())))
    else: print("No command numbers outside the documented set were seen.")
    print(f"saved: watch_{stamp}.log and watch_{stamp}.jsonl")


if __name__ == "__main__":
    main()
