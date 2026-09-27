"""The shot plan that animate_shot.py (Blender) reads: who stands where, and a track of
actions per character on the audio-first timing. Everything that makes the talking look
alive is decided here, by rule, from the script and the timeline (training lab, "what
makes speech alive"):

- the gesture starts four frames before the line, because the hand leads the voice;
- brows go up on a question and on surprise;
- blinks every 2-5 s at random (seeded per shot, so a re-render is identical), plus one
  at the end of every sentence;
- whoever is not talking looks at the speaker and nods (listen_nod);
- Mira's scarf follows her feeling, blending over 0.5 s;
- each character's motion_style scales the speed and bounce of the same library.

With an acting plan (acting.py, written by the acting director) the gestures land on
their words, the face changes inside lines, listeners react in character and the camera
moves in on the emotional turn; the rules above stay as the default for anything the
plan leaves open."""
from __future__ import annotations

import random
import zlib

from .bible.models import Bible
from .episode import SCARF, Episode
from .text import sentences
from .timing import Shot, Timeline

GESTURE_LEAD_FRAMES = 4
LISTEN_DELAY_S = 0.2
SCARF_BLEND_S = 0.5
TALK_GESTURES = ("talk_gesture_a", "talk_gesture_b")


def _positions(n: int) -> list[float]:
    if n == 1:
        return [0.5]
    lo, hi = (0.35, 0.65) if n == 2 else (0.2, 0.8)
    return [round(lo + (hi - lo) * i / (n - 1), 3) for i in range(n)]


def _on_screen(ep: Episode, shot: Shot) -> list[str]:
    """The speakers, plus the one they answer or who answers them: nobody talks to air."""
    cast = shot.speakers
    if len(cast) == 1:
        order = [l.speaker for l in ep.lines()]
        first = next(i for i, l in enumerate(ep.lines()) if l.id == shot.lines[0].line_id)
        last = next(i for i, l in enumerate(ep.lines()) if l.id == shot.lines[-1].line_id)
        near = [order[j] for j in (first - 1, last + 1) if 0 <= j < len(order)]
        other = next((c for c in near if c != cast[0]), None)
        if other:
            cast.append(other)
    return cast


def _has_scarf(bible: Bible, ch: str) -> bool:
    c = bible.characters.get(ch)
    return bool(c) and c.visual.signature.startswith("scarf_that_changes_colour")


def blinks(duration: float, seed: int, sentence_ends: list[float]) -> list[float]:
    rng = random.Random(seed)
    t, out = rng.uniform(0.5, 2.0), []
    while t < duration:
        out.append(round(t, 3))
        t += rng.uniform(2.0, 5.0)
    out += [round(e, 3) for e in sentence_ends if e < duration]
    out.sort()
    return [b for i, b in enumerate(out) if i == 0 or b - out[i - 1] >= 0.4]


def principles(ch) -> dict:
    """The animation principles for Blender, scaled by the character's motion style: a
    faster, bouncier character anticipates less and overshoots more."""
    ms = ch.motion_style
    return {"anticipation_frames": max(2, round(4 / ms.speed)), "overshoot": round(0.08 * ms.bounce, 3),
            "settle_frames": max(2, round(5 / ms.speed)), "ease": "in_out", "secondary_delay_frames": 2}


def shot_plan(bible: Bible, ep: Episode, tl: Timeline, acting=None) -> list[dict]:
    """acting: an ActingPlan from the acting director (studio act). Without it every line
    gets the default performance by rule."""
    from .acting import GESTURE_LEAD_FRAMES as LEAD, REACTION_DELAY_S, word_times
    lines = {l.id: l for l in ep.lines()}
    directed = {la.line_id: la for la in acting.lines} if acting else {}
    frame = 1 / tl.fps
    plans = []
    for shot in tl.shots:
        cast = _on_screen(ep, shot)
        xs = _positions(len(cast))
        tracks = {c: [{"t": 0.0, "action": "idle_breathe"}] for c in cast}
        brows = {c: [] for c in cast}
        face = {c: [] for c in cast}
        ends = {c: [] for c in cast}
        scarf, camera = [], []
        for n, lt in enumerate(shot.lines):
            line = lines[lt.line_id]
            la = directed.get(lt.line_id)
            wt = word_times(line.text, ep.language, lt.start, lt.end)
            gestures = [b for b in la.beats if b.action] if la else []
            if gestures:
                for b in gestures:
                    tracks[lt.speaker].append({"t": round(max(0.0, wt[b.word].start - LEAD * frame), 3), "action": b.action,
                                               "expr": line.emotion, "line": lt.line_id, "word": b.word})
            else:
                gesture = line.action or TALK_GESTURES[n % 2]
                tracks[lt.speaker].append({"t": round(max(0.0, lt.start - GESTURE_LEAD_FRAMES * frame), 3),
                                           "action": gesture, "expr": line.emotion, "line": lt.line_id})
            for b in (la.beats if la else []):
                keys = {k: v for k, v in b.model_dump(exclude={"word", "action"}).items() if v is not None}
                if keys:
                    face[lt.speaker].append({"t": wt[b.word].start, "line": lt.line_id, "word": b.word, **keys})
            if la and la.hold_action and lt.hold:
                tracks[lt.speaker].append({"t": round(lt.end + 0.1, 3), "action": la.hold_action, "line": lt.line_id})
            reacting = {x.character for x in la.listeners} if la else set()
            for x in (la.listeners if la else []):
                if x.character not in cast:
                    continue  # off screen in this shot
                t = round(wt[x.word].start + REACTION_DELAY_S, 3)
                if x.action:
                    tracks[x.character].append({"t": t, "action": x.action, "react_to": lt.line_id})
                keys = {k: v for k, v in x.model_dump(exclude={"character", "word", "action"}).items() if v is not None}
                face[x.character].append({"t": t, "line": lt.line_id, "look": lt.speaker, **keys})
            for c in cast:
                if c != lt.speaker and c not in reacting:
                    tracks[c].append({"t": round(lt.start + LISTEN_DELAY_S, 3), "action": "listen_nod", "look_at": lt.speaker})
            if la and la.camera != "hold":
                camera.append({"t": lt.start, "move": la.camera, "line": lt.line_id})
            directed_brows = la and any(b.brows for b in la.beats)
            if not directed_brows and (line.text.rstrip().endswith("?") or line.emotion == "surprised"):
                brows[lt.speaker].append({"t": lt.start, "state": "raised"})
                brows[lt.speaker].append({"t": round(lt.end, 3), "state": "normal"})
            # sentence ends, spread over the line by characters (the audio gives the line's end)
            text = line.text
            acc = 0
            for s in sentences(text):
                acc += len(s) + 1
                ends[lt.speaker].append(lt.start + (lt.end - lt.start) * min(1.0, acc / max(1, len(text))))
            if _has_scarf(bible, lt.speaker) and line.emotion in SCARF:
                scarf.append({"t": lt.start, "color": SCARF[line.emotion], "blend_s": SCARF_BLEND_S})
        cast_plans = []
        for c, x in zip(cast, xs):
            ch = bible.characters[c]
            seed = zlib.crc32(f"{ep.id}/{shot.id}/{c}".encode())
            entry = {
                "ch": c, "x": x, "facing": "right" if x < 0.5 else "left",
                "speed": ch.motion_style.speed, "bounce": ch.motion_style.bounce, "principles": principles(ch),
                "track": sorted(tracks[c], key=lambda k: k["t"]),
                "brows": brows[c], "face": sorted(face[c], key=lambda k: k["t"]),
                "blinks": blinks(shot.duration, seed, ends[c]),
            }
            if _has_scarf(bible, c) and scarf:
                entry["scarf"] = scarf
            cast_plans.append(entry)
        plans.append({
            "shot": shot.id, "segment": shot.segment,
            "bg": f"{shot.place}_{shot.lighting}", "duration_s": shot.duration,
            "frames": round(shot.duration * tl.fps), "fps": tl.fps,
            "lines": [{"id": lt.line_id, "ch": lt.speaker, "start": lt.start, "end": round(lt.end, 3), "tempo": lt.tempo}
                      for lt in shot.lines],
            "camera": camera,
            "cast": cast_plans,
        })
    return plans
