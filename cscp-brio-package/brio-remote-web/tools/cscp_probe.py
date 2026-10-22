#!/usr/bin/env python3
"""
cscp_probe.py - READ-ONLY command scanner for a Calrec desk over CSCP.

Sends *read-form* requests (write bit 0x8000 clear) for every command number in a
range and records how the desk reacts: NAK (with the raw error byte), ACK + data
reply, ACK only, or silence. Commands the desk answers differently from a bogus
command are candidates for undocumented features.

It never sends a write-form command (the script refuses to). Even so, an
UNDOCUMENTED command may not obey the "write bit = write" convention, so:
  * run it with the desk OFF AIR, on a spare show/memory, with a backup saved;
  * start with the default small range and look at the report before going wider.

Needs only Python 3.8+ (standard library).

  python cscp_probe.py 192.168.0.10 --port 49200                 # 0x0000-0x00FF
  python cscp_probe.py 192.168.0.10 --port 49200 --start 0 --end 0x7FFF   # long (~hours)
  python cscp_probe.py --report probe_20261021_2100.jsonl        # re-read a past run
"""
import argparse, json, socket, sys, time, collections

SOH, ACK, NAK = 0xF1, 0x04, 0x05
MAX_BC = 50
KNOWN = {  # documented commands (v22), for labelling only
    0x0000: "7.3 fader level", 0x0001: "7.4 fader cut", 0x0002: "7.7 main level",
    0x0005: "7.5 fader PFL", 0x0007: "7.1 name", 0x0008: "7.2 console info",
    0x000B: "7.6 fader label", 0x000C: "7.8 main PFL", 0x000D: "7.9 main label",
    0x0010: "7.10 available aux", 0x0011: "7.11 assignment", 0x0012: "7.12 aux send on/off",
    0x0013: "7.13 aux output level", 0x0014: "7.15 available mains", 0x0015: "7.16 route to main",
    0x0016: "7.17 L>B / R>B",
}
# NAK bit order is an ASSUMPTION (the doc's figure is not in the text export).
# Seen on a real Brio: 0x40 = unknown command, 0x05 = wrong data length (fits the doc list read MSB-first).
NAK_BITS = [(0x40, "cmdNotSupported"), (0x20, "timeout"), (0x10, "undefined"),
            (0x08, "interface"), (0x04, "byteCount"), (0x02, "checksum"), (0x01, "protocol")]


def checksum(body):
    return (-sum(body)) & 0xFF


def frame(cmd, data=b""):
    if cmd & 0x8000:
        raise SystemExit("refusing to send a write-form command")
    body = bytes([cmd >> 8, cmd & 0xFF]) + data
    assert len(body) <= MAX_BC
    return bytes([SOH, len(body), 0x00]) + body + bytes([checksum(body)])


class Link:
    def __init__(self, host, port):
        self.s = socket.create_connection((host, port), timeout=5)
        self.s.settimeout(0.05)
        self.buf = bytearray()

    def send(self, b):
        self.s.sendall(b)

    def pump(self):
        try:
            d = self.s.recv(4096)
            if d == b"":
                raise ConnectionError("desk closed the connection")
            self.buf += d
        except socket.timeout:
            pass

    def events(self):
        """Parse whatever is buffered into ('ack',) ('nak',b) ('frame',cmd,data) events."""
        out, b, i = [], self.buf, 0
        while i < len(b):
            c = b[i]
            if c == ACK:
                out.append(("ack",)); i += 1
            elif c == NAK:
                if i + 1 >= len(b): break
                out.append(("nak", b[i + 1])); i += 2
            elif c == SOH:
                if i + 1 >= len(b): break
                bc = b[i + 1]
                if not 2 <= bc <= MAX_BC: i += 1; continue
                if i + 4 + bc > len(b): break
                body = bytes(b[i + 3:i + 3 + bc])
                if checksum(body) != b[i + 3 + bc]: i += 1; continue
                out.append(("frame", (body[0] << 8) | body[1], body[2:])); i += 4 + bc
            else:
                i += 1
        del b[:i]
        return out


def probe_once(link, cmd, data, wait):
    link.send(frame(cmd, data))
    t0, evs = time.monotonic(), []
    while time.monotonic() - t0 < wait:
        link.pump()
        evs += link.events()
    res = {"ack": False, "nak": None, "reply": None, "other": []}
    for e in evs:
        if e[0] == "ack": res["ack"] = True
        elif e[0] == "nak": res["nak"] = e[1]
        elif e[0] == "frame":
            if (e[1] & 0x7FFF) == cmd: res["reply"] = {"cmd": e[1], "data": e[2].hex()}
            else: res["other"].append({"cmd": e[1], "len": len(e[2])})  # unsolicited known traffic
    return res


def classify(r):
    if r["reply"]: return "REPLY"
    if r["nak"] is not None: return f"NAK 0x{r['nak']:02X}"
    if r["ack"]: return "ACK-only"
    return "silent"


PAYLOADS = [b"", b"\x00", b"\x00\x00", b"\x00\x00\x00\x00"]


def run(a):
    link = Link(a.host, a.port)
    out = open(a.out, "w")
    def log(rec): out.write(json.dumps(rec) + "\n"); out.flush()

    # prime the link: the desk only starts talking after the first valid message
    probe_once(link, 0x0008, b"", 0.5)
    print("Calibration (known good / known bogus):")
    for name, cmd, data in [("7.1 name", 0x0007, b""), ("7.2 info", 0x0008, b""),
                            ("7.3 level f0", 0x0000, b"\x00\x00"), ("bogus 0x7FFF", 0x7FFF, b""),
                            ("bogus 0x7F00", 0x7F00, b"")]:
        r = probe_once(link, cmd, data, a.wait)
        print(f"  {name:14} -> {classify(r)}")
        log({"phase": "calib", "name": name, "cmd": cmd, "data": data.hex(), **r})
    print("The NAK byte for the bogus commands is the 'not supported' signature; anything else is interesting.\n")

    payloads = PAYLOADS[:a.payloads]
    total = (a.end - a.start + 1) * len(payloads)
    print(f"Scanning 0x{a.start:04X}-0x{a.end:04X}: {total} requests at ~{1/(a.delay+a.wait):.2f}/s (about {total*(a.delay+a.wait)/3600:.1f} h). Ctrl-C to stop; the log is kept.")
    n, t0 = 0, time.time()
    try:
        for cmd in range(a.start, a.end + 1):
            for data in payloads:
                r = probe_once(link, cmd, data, a.wait)
                log({"phase": "scan", "cmd": cmd, "data": data.hex(), **r})
                n += 1
                if r["reply"]:
                    tag = KNOWN.get(cmd, "UNDOCUMENTED")
                    print(f"  0x{cmd:04X} [{data.hex() or '-'}] REPLY {r['reply']['data'][:60]}  <- {tag}")
                time.sleep(a.delay)
            if cmd % 64 == 63:
                print(f"  ...0x{cmd:04X} done ({n}/{total}, {time.time()-t0:.0f}s)")
    except KeyboardInterrupt:
        print("\nstopped by user")
    finally:
        out.close(); link.s.close()
    print(f"\nlog: {a.out}")
    report(a.out)


def report(path):
    rows = [json.loads(l) for l in open(path)]
    calib = {r["name"]: r for r in rows if r["phase"] == "calib"}
    bogus = {classify(r) for k, r in calib.items() if k.startswith("bogus")}
    print(f"\nBogus-command signature: {sorted(bogus)}")
    per = collections.defaultdict(set)
    for r in rows:
        if r["phase"] == "scan": per[r["cmd"]].add(classify(r))
    print("\nCommands that answer differently from a bogus command:")
    found = 0
    for cmd in sorted(per):
        if per[cmd] <= bogus: continue
        found += 1
        print(f"  0x{cmd:04X}  {KNOWN.get(cmd, 'UNDOCUMENTED'):20} {sorted(per[cmd])}")
    if not found: print("  (none)")
    undoc = [c for c in per if c not in KNOWN and not per[c] <= bogus]
    print(f"\n{len(undoc)} undocumented candidate(s)." + (" Next: send them to me (the .jsonl) and we'll work out the payloads." if undoc else ""))


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("host", nargs="?"); p.add_argument("--port", type=int, default=49200)
    p.add_argument("--start", type=lambda x: int(x, 0), default=0x0000)
    p.add_argument("--end", type=lambda x: int(x, 0), default=0x00FF)
    p.add_argument("--delay", type=float, default=0.03, help="pause between requests (s)")
    p.add_argument("--wait", type=float, default=0.12, help="how long to listen after each request (s)")
    p.add_argument("--rate", type=float, help="requests per second (overrides --delay), e.g. 1 for one per second")
    p.add_argument("--payloads", type=int, default=4, choices=[1, 2, 3, 4],
                   help="payload variants per command: 1=empty only ... 4=empty,1,2,4 zero bytes (default 4)")
    p.add_argument("--out", default=time.strftime("probe_%Y%m%d_%H%M.jsonl"))
    p.add_argument("--report", help="summarise an existing .jsonl instead of scanning")
    a = p.parse_args()
    if a.rate: a.delay = max(0.0, 1.0 / a.rate - a.wait)
    if a.report: report(a.report)
    elif not a.host or a.end >= 0x8000 or a.start > a.end: p.error("need host and 0 <= start <= end < 0x8000")
    else: run(a)
