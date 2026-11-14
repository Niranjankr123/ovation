#!/usr/bin/env python3
"""Cut the demo video from the recorded shots and the narration.

    python demo/edit.py            writes demo/ovation-demo.mp4 and demo/out/ovation-demo-voice-only.mp4
    python demo/edit.py plan       prints the timeline and stops
    python demo/edit.py draft      stands in silence for narration clips that do not exist yet

The narration sets the timing. Each section names its lines and which stretch of which shot
to show; the footage is sped up or held to fit. Captions are burned in, because X plays
videos muted until someone taps.

Needs ffmpeg (on PATH, or its path in the FFMPEG variable) and: pip install pillow numpy
"""
import bisect
import json
import math
import os
import subprocess
import sys
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
SHOTS = os.path.join(OUT, "shots")
VOICE = os.path.join(OUT, "voice")
WORK = os.path.join(OUT, "work")
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FPS = 30
W, H = 1920, 1080
RATE = 48000
TEMPO = 0.92  # The voice model talks fast. This brings it to an easy pace.
GAP = 0.36  # Between two lines of one section.
TAIL = 0.5  # After the last line of a section.
LEAD = 0.18
MAX_SLOW = 1.5  # Footage is never slowed more than this; beyond it the last frame is held.

MODE = sys.argv[1] if len(sys.argv) > 1 else "final"
DRAFT = MODE == "draft"

FONT_DIR = os.environ.get("FONT_DIR", "C:/Windows/Fonts")


def font(size, bold=True):
    for name in (["seguisb.ttf", "segoeuib.ttf"] if bold else ["segoeui.ttf"]) + ["arial.ttf", "DejaVuSans.ttf"]:
        try:
            return ImageFont.truetype(os.path.join(FONT_DIR, name), size)
        except OSError:
            continue
    return ImageFont.load_default()


# ---------------------------------------------------------------------------
# The cut list. A piece is (shot, from, to): moments are a mark's name, plus or minus seconds.
# ---------------------------------------------------------------------------
TESTNET_NOTE = "Live on NEAR testnet. Test tokens. Waits shortened."
SECTIONS = [
    {"lines": ["01"], "video": [("card-intro1", "start", "end")]},
    {"lines": ["02"], "video": [("card-intro2", "start", "end")]},
    {"lines": ["03"], "video": [("card-intro3", "start", "end")]},
    {"lines": ["04"], "video": [("card-intro4", "start", "end")], "tail": 0.7},
    {"lines": ["05"], "video": [("card-brand", "start", "end")], "tail": 0.6},
    {"lines": ["06"], "video": [("open", "start+0.3", "end")], "tag": True},
    {"lines": ["07"], "video": [("stage", "who-1.2", "send+0.5"), ("stage", "landed-0.3", "landed+1.3")], "tag": True, "lead": 0.4, "tail": 2.2},
    {"lines": ["08"], "video": [("stage", "scrolled-0.5", "scrolled+0.5"), ("stage", "diego-0.5", "end")], "tag": True, "tail": 0.9},
    {"lines": ["09"], "video": [("feed", "start", "post+2.6")], "tag": True},
    {"lines": ["10"], "video": [("feed", "post+2.6", "end")], "tag": True, "note": "near.social notifies everyone a post mentions. Shown here: the testnet index of the same data."},
    {"lines": ["11"], "video": [("cheat", "start+0.2", "send+0.4"), ("cheat", "landed-0.2", "end")], "tag": True, "tail": 0.7},
    {"lines": ["12"], "video": [("how", "start+0.5", "end")], "tag": True, "tail": 0.8},
    {"lines": ["13"], "video": [("closing", "start", "end"), ("payouts", "start+0.4", "kofi-filed-click+0.5"), ("payouts", "kofi-filed-0.4", "kofi-filed+1.0"), ("payouts", "kofi-paid-0.3", "kofi-paid+0.9")], "tag": True, "note": "Rounds last two minutes in this demo. A real stage would use weeks."},
    {"lines": ["14"], "video": [("payouts", "june-filed-0.3", "june-filed+0.6"), ("payouts", "asha", "june-approved-click+0.4"), ("payouts", "june-approved-0.3", "june-approved+0.9")], "tag": True},
    {"lines": ["15"], "video": [("payouts", "ravi-filed-click-0.6", "ravi-filed-click+0.4"), ("payouts", "ravi-filed-0.3", "ravi-filed+0.7"), ("payouts", "vote1-click-0.5", "vote1-click+0.3"), ("payouts", "vote1-0.2", "vote1+0.4"), ("payouts", "diego-0.2", "vote2-click+0.3"), ("payouts", "vote2-0.2", "vote2+0.5"), ("payouts", "ravi-paid-0.3", "ravi-paid+1.3")], "tag": True, "tail": 0.8},
    # The round's total is a shot of its own, filmed once every payout reads Paid.
    {"lines": ["16"], "video": [("total", "total-0.6", "end")], "tag": True},
    {"lines": ["17"], "video": [("record", "start", "lines+2.2")], "tag": True},
    {"lines": ["18"], "video": [("record", "trusted-1.0", "end")], "tag": True, "tail": 0.7},
    {"lines": ["19"], "video": [("card-d0", "start", "end")]},
    {"lines": ["20"], "video": [("card-d1", "start", "end")]},
    {"lines": ["21"], "video": [("card-d2", "start", "end")]},
    {"lines": ["22"], "video": [("card-d3", "start", "end")], "tail": 0.7},
    {"lines": ["23"], "video": [("card-close1", "start", "end")], "tail": 0.8},
    {"lines": ["24"], "video": [("card-close2", "start", "end")], "tail": 2.4},
]


def ffmpeg(args, data=None):
    res = subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *args], input=data, capture_output=True)
    if res.returncode != 0:
        sys.exit("ffmpeg failed:\n" + res.stderr.decode(errors="replace")[-2500:])


def wav_seconds(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / w.getframerate()


def read_wav(path):
    with wave.open(path, "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def write_wav(path, samples):
    data = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data.tobytes())


# ---------------------------------------------------------------------------
# Narration
# ---------------------------------------------------------------------------
def prepare_voice(lines):
    """Slow each clip a little, tidy it, and return how long each one runs."""
    seconds = {}
    for line in lines:
        src = os.path.join(VOICE, f"{line['id']}.wav")
        dst = os.path.join(WORK, f"voice-{line['id']}.wav")
        if os.path.exists(src):
            chain = f"atempo={TEMPO},highpass=f=70,acompressor=threshold=-21dB:ratio=2.2:attack=10:release=180:makeup=1.5,aresample={RATE}"
            ffmpeg(["-i", src, "-af", chain, "-ac", "1", "-c:a", "pcm_s16le", dst])
        elif DRAFT or MODE == "plan":
            write_wav(dst, np.zeros(int(RATE * max(1.4, len(line["text"].split()) / 2.5)), dtype=np.float32))
        else:
            sys.exit(f"no narration clip for line {line['id']}: run demo/voice.py, or use `draft`")
        seconds[line["id"]] = wav_seconds(dst)
    return seconds


def lay_out(seconds):
    """Give every section and every line its place on the timeline."""
    t = 0.0
    out = []
    for i, sec in enumerate(SECTIONS):
        x = t + sec.get("lead", LEAD)
        starts = {}
        for j, line_id in enumerate(sec["lines"]):
            starts[line_id] = x
            x += seconds[line_id] + (GAP if j < len(sec["lines"]) - 1 else 0)
        end = x + sec.get("tail", TAIL)
        out.append({**sec, "n": i, "t0": t, "t1": end, "starts": starts})
        t = end
    return out, t


# ---------------------------------------------------------------------------
# Footage
# ---------------------------------------------------------------------------
class Shot:
    def __init__(self, name):
        self.dir = os.path.join(SHOTS, name)
        with open(os.path.join(self.dir, "frames.json"), encoding="utf-8") as fh:
            data = json.load(fh)
        self.frames = data["frames"]
        self.marks = data["marks"]
        self.times = [f["t"] for f in self.frames]

    def when(self, spec):
        name, sign, offset = spec, 1, 0.0
        for s in ("+", "-"):
            # a mark's own name may contain "-", so split on the last sign followed by a number
            k = spec.rfind(s)
            if k > 0:
                try:
                    offset = float(spec[k + 1 :])
                    name, sign = spec[:k], (1 if s == "+" else -1)
                    break
                except ValueError:
                    pass
        if name not in self.marks:
            sys.exit(f"shot {os.path.basename(self.dir)} has no mark {name!r}; it has {sorted(self.marks)}")
        return self.marks[name] + sign * offset

    def frame_at(self, t):
        k = bisect.bisect_right(self.times, t) - 1
        return os.path.join(self.dir, self.frames[max(0, k)]["file"])


_shots = {}


def shot(name):
    if name not in _shots:
        _shots[name] = Shot(name)
    return _shots[name]


def section_frames(sec):
    """Which recorded frame is on screen for each output frame of this section."""
    length = sec["t1"] - sec["t0"]
    pieces = []
    for name, a, b in sec["video"]:
        if not os.path.exists(os.path.join(SHOTS, name, "frames.json")):
            if DRAFT or MODE == "plan":
                continue
            sys.exit(f"shot {name} has not been recorded")
        s = shot(name)
        t0, t1 = s.when(a), s.when(b)
        if t1 > t0:
            pieces.append((s, t0, t1))
    if not pieces:
        return None, 0
    natural = sum(t1 - t0 for _, t0, t1 in pieces)
    speed = max(natural / length, 1.0 / MAX_SLOW)  # seconds of footage per second of video
    files = []
    for k in range(int(round(length * FPS))):
        want = k / FPS * speed
        for s, t0, t1 in pieces:
            if want < t1 - t0:
                files.append(s.frame_at(t0 + want))
                break
            want -= t1 - t0
        else:
            s, t0, t1 = pieces[-1]
            files.append(s.frame_at(t1))
    return files, speed


# ---------------------------------------------------------------------------
# Captions and labels, drawn as transparent overlays
# ---------------------------------------------------------------------------
def wrap(draw, text, fnt, width):
    lines, cur = [], ""
    for word in text.split():
        trial = (cur + " " + word).strip()
        if draw.textlength(trial, font=fnt) <= width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def caption_png(text, path, note=None):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    fnt = font(50)
    lines = wrap(d, text, fnt, 1480)
    line_h = 66
    box_w = max(d.textlength(l, font=fnt) for l in lines) + 76
    box_h = line_h * len(lines) + 40
    x0 = (W - box_w) / 2
    y0 = H - 62 - box_h
    d.rounded_rectangle([x0, y0, x0 + box_w, y0 + box_h], radius=26, fill=(20, 19, 15, 224))
    for i, l in enumerate(lines):
        d.text((W / 2, y0 + 20 + line_h * i + line_h / 2 - 4), l, font=fnt, fill=(255, 255, 255, 255), anchor="mm")
    if note:
        nf = font(27, bold=False)
        nw = d.textlength(note, font=nf) + 44
        ny = y0 - 62
        d.rounded_rectangle([(W - nw) / 2, ny, (W + nw) / 2, ny + 46], radius=23, fill=(251, 241, 217, 240))
        d.text((W / 2, ny + 22), note, font=nf, fill=(60, 44, 8, 255), anchor="mm")
    img.save(path)


def tag_png(path):
    # Two short lines in the empty middle of the site's header, between the last menu item
    # (ends near x=1050) and the "Acting as" menu (starts near x=1510), which must stay
    # visible: it shows who is signing.
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    fnt = font(20, bold=False)
    rows = [s.strip() + "." for s in TESTNET_NOTE.rstrip(".").split(".", 1)]
    w = max(d.textlength(r, font=fnt) for r in rows) + 36
    cx, y0, h = 1278, 14, 64
    d.rounded_rectangle([cx - w / 2, y0, cx + w / 2, y0 + h], radius=16, fill=(251, 241, 217, 245), outline=(231, 224, 210, 255))
    for i, r in enumerate(rows):
        d.text((cx, y0 + 19 + i * 26), r, font=fnt, fill=(88, 66, 14, 255), anchor="mm")
    img.save(path)


def split_caption(text, limit=74):
    """Long lines are shown a sentence or two at a time."""
    parts, cur = [], ""
    for sentence in [s.strip() for s in text.replace("? ", "?|").replace("! ", "!|").replace(". ", ".|").split("|") if s.strip()]:
        if cur and len(cur) + 1 + len(sentence) > limit:
            parts.append(cur)
            cur = sentence
        else:
            cur = (cur + " " + sentence).strip()
    if cur:
        parts.append(cur)
    return parts


def overlays_for(sec, lines, seconds):
    out = []
    if sec.get("tag"):
        out.append((os.path.join(WORK, "tag.png"), 0, sec["t1"] - sec["t0"]))
    for line_id in sec["lines"]:
        text = lines[line_id]["text"]
        start = sec["starts"][line_id] - sec["t0"]
        parts = split_caption(text)
        total = sum(len(p) for p in parts)
        t = start
        for k, part in enumerate(parts):
            span = seconds[line_id] * len(part) / total
            path = os.path.join(WORK, f"cap-{line_id}-{k}.png")
            caption_png(part, path, sec.get("note"))
            last = k == len(parts) - 1
            out.append((path, max(0, t - 0.06), t + span + (0.28 if last else 0)))
            t += span
    return out


def render_section(sec, lines, seconds):
    files, speed = section_frames(sec)
    n = int(round((sec["t1"] - sec["t0"]) * FPS))
    target = os.path.join(WORK, f"sec-{sec['n']:02d}.mp4")
    overlays = overlays_for(sec, lines, seconds)
    args = []
    if files is None:
        args += ["-f", "lavfi", "-i", f"color=c=0xfaf6ee:s={W}x{H}:r={FPS}"]
        data = None
    else:
        args += ["-f", "image2pipe", "-framerate", str(FPS), "-c:v", "mjpeg", "-i", "-"]
        cache = {}
        chunks = []
        for f in files:
            if f not in cache:
                with open(f, "rb") as fh:
                    cache[f] = fh.read()
            chunks.append(cache[f])
        data = b"".join(chunks)
    for path, _, _ in overlays:
        args += ["-loop", "1", "-framerate", str(FPS), "-i", path]
    chain = [f"[0:v]scale={W}:{H}:flags=lanczos,format=yuvj420p[b0]"]
    for i, (_, a, b) in enumerate(overlays):
        chain.append(f"[b{i}][{i + 1}:v]overlay=0:0:enable='between(t,{a:.3f},{b:.3f})'[b{i + 1}]")
    # Screen frames are full-range JPEGs with the old 601 matrix; video players expect TV range and 709.
    chain.append(f"[b{len(overlays)}]scale=in_color_matrix=bt601:out_color_matrix=bt709:in_range=full:out_range=tv,format=yuv420p[v]")
    args += [
        "-filter_complex", ";".join(chain), "-map", "[v]", "-frames:v", str(n), "-r", str(FPS),
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", target,
    ]
    ffmpeg(args, data)
    return target, speed


# ---------------------------------------------------------------------------
# Sound
# ---------------------------------------------------------------------------
def narration_track(plan, total):
    track = np.zeros(int((total + 1) * RATE), dtype=np.float32)
    for sec in plan:
        for line_id, start in sec["starts"].items():
            clip = read_wav(os.path.join(WORK, f"voice-{line_id}.wav"))
            k = int(start * RATE)
            track[k : k + len(clip)] += clip[: len(track) - k]
    return track


def music_bed(total, voice):
    """A quiet pad under the voice. Every note is synthesised here, so there is nothing to license."""
    n = int((total + 1) * RATE)
    t = np.arange(n) / RATE
    # A minor, F, C, G: eight seconds each, voiced in the middle of the keyboard.
    chords = [(220.0, 261.63, 329.63), (174.61, 220.0, 261.63), (196.0, 261.63, 329.63), (196.0, 246.94, 293.66)]
    bar = 8.0
    bed = np.zeros(n, dtype=np.float32)
    for i in range(int(math.ceil((total + 1) / bar))):
        notes = chords[i % len(chords)]
        t0 = i * bar
        env = np.clip((t - t0) / 2.2, 0, 1) * np.clip((t0 + bar + 2.2 - t) / 2.2, 0, 1)
        env = np.where((t >= t0) & (t <= t0 + bar + 2.2), env, 0).astype(np.float32)
        for f in notes:
            wobble = 1 + 0.0015 * np.sin(2 * np.pi * 0.21 * t + f)
            tone = np.sin(2 * np.pi * f * wobble * t) + 0.32 * np.sin(2 * np.pi * 2 * f * t) + 0.5 * np.sin(2 * np.pi * (f / 2) * t)
            bed += (tone * env / 9.0).astype(np.float32)
    # Duck under the voice, and fade in and out.
    level = np.abs(voice[:n])
    win = int(0.35 * RATE)
    smooth = np.convolve(level, np.ones(win, dtype=np.float32) / win, mode="same")
    duck = 1.0 - 0.55 * np.clip(smooth / 0.03, 0, 1)
    fade = np.clip(t / 1.5, 0, 1) * np.clip((total - t) / 2.5, 0, 1)
    return (bed * duck * fade * 0.16).astype(np.float32)


# ---------------------------------------------------------------------------
def main():
    os.makedirs(WORK, exist_ok=True)
    with open(os.path.join(HERE, "lines.json"), encoding="utf-8") as fh:
        lines = {l["id"]: l for l in json.load(fh)}
    seconds = prepare_voice(list(lines.values()))
    plan, total = lay_out(seconds)
    print(f"{len(plan)} sections, {total:.1f} s ({int(total // 60)}:{total % 60:04.1f})")
    for sec in plan:
        files, speed = section_frames(sec)
        what = ", ".join(sorted({name for name, _, _ in sec["video"]}))
        print(f"  {sec['t0']:6.2f}  {sec['t1'] - sec['t0']:5.2f}s  x{speed:4.2f}  {what:<22} {' '.join(sec['lines'])}: {lines[sec['lines'][0]]['text'][:54]}")
    if total > 138:
        print("WARNING: longer than 2:18. A standard X account takes at most 2:20.")
    if MODE == "plan":
        return

    tag_png(os.path.join(WORK, "tag.png"))
    parts = []
    for sec in plan:
        target, _ = render_section(sec, lines, seconds)
        parts.append(target)
        print(f"  rendered section {sec['n'] + 1} of {len(plan)}", flush=True)
    with open(os.path.join(WORK, "parts.txt"), "w", encoding="utf-8") as fh:
        for p in parts:
            fh.write(f"file '{os.path.basename(p)}'\n")
    silent = os.path.join(WORK, "silent.mp4")
    ffmpeg(["-f", "concat", "-safe", "0", "-i", os.path.join(WORK, "parts.txt"), "-c", "copy", silent])

    voice = narration_track(plan, total)
    write_wav(os.path.join(WORK, "voice.wav"), voice)
    write_wav(os.path.join(WORK, "mix.wav"), voice + music_bed(total, voice))
    name = "ovation-demo-draft" if DRAFT else "ovation-demo"
    final = os.path.join(OUT if DRAFT else HERE, f"{name}.mp4")
    for audio, target in ((os.path.join(WORK, "mix.wav"), final), (os.path.join(WORK, "voice.wav"), os.path.join(OUT, f"{name}-voice-only.mp4"))):
        ffmpeg([
            "-i", silent, "-i", audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy",
            "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", str(RATE), "-ac", "2", "-c:a", "aac", "-b:a", "192k",
            "-t", f"{total:.3f}", "-movflags", "+faststart", target,
        ])
        print(f"wrote {os.path.relpath(target, os.path.dirname(HERE))}  {os.path.getsize(target) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
