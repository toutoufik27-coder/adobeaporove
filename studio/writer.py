"""From an idea to a gated episode.json, in every live language.

  gate 0 (code chooses the idea)
  -> the model drafts the script (structured)
  -> gate 1 text + novelty (code)       -- errors go back to the model, up to 3 rounds
  -> gate 2 behaviour (model, with the bible)
  -> gate 3 adversarial review (model, a separate call that never saw the brief)
  -> translation per live language -> gate 1 in that language (dub length ±15 %)
  -> saved, recorded in the ledger.

Line ids are assigned here, never by the model: the translations and every later step
refer to them."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from .bible.models import Bible
from .episode import MOTIONS, Beat, Emotion, Episode, Idea, Line, Motion
from .gates import GateReport
from .gates.idea import check_idea, choose_idea
from .gates.novelty import check_novelty
from .gates.text import check_text
from .ledger import Ledger
from .llm import LLM

MAX_ROUNDS = 3
SECONDS_PER_LINE = 3.6  # speech + reserve + a little action, for the brief's line budget


# ---------------------------------------------------------------- what the model returns
class DraftLine(BaseModel):
    speaker: str = Field(description="character id, e.g. ch_01")
    text: str
    emotion: Emotion = "neutral"
    action: Motion | None = Field(None, description="one action from the motion library, or null")
    hold_s: float = Field(0.0, description="seconds of wordless action after the line (0-8)")


class DraftBeat(BaseModel):
    segment: str
    place: str
    lighting: Literal["morning", "afternoon", "evening"] = "morning"
    lines: list[DraftLine]


class Draft(BaseModel):
    title: str
    logline: str
    beats: list[DraftBeat]


class TLine(BaseModel):
    id: str
    text: str


class Translation(BaseModel):
    lines: list[TLine]


class ReviewFinding(BaseModel):
    line_id: str | None = None
    severity: Literal["error", "warning"]
    code: str = Field(description="short kebab-case label")
    message: str


class Review(BaseModel):
    findings: list[ReviewFinding]
    summary: str


# ---------------------------------------------------------------- briefs
def _chars(bible: Bible, ids: list[str], lang: str) -> str:
    out = []
    for cid in ids:
        c = bible.characters[cid]
        s = c.personality.speech
        out.append(
            f"- {c.id} {c.name} ({c.role}; domain: {c.domain}). Traits: {', '.join(c.personality.traits)}. "
            f"Speaks {s.sentence_words[0]}-{s.sentence_words[1]} words a sentence, {s.tone}, style {s.style}, "
            f"pace {c.voice.pace}. Catchphrase ({lang}): \"{s.catchphrase.get(lang, '')}\". "
            f"Never: {'; '.join(c.personality.never_does)}."
        )
    return "\n".join(out)


def _rules(bible: Bible, lang: str) -> str:
    lx = bible.lexicons[lang]
    return (
        f"World rules (these situations never exist): {'; '.join(bible.world.rules)}.\n"
        f"Language rules ({lang}): at most {lx.max_sentence_words} words in any sentence; words of at most "
        f"{lx.max_syllables} syllables except {', '.join(lx.allowed_long_words) or 'none'} and the names; "
        f"never: {', '.join(lx.banned)}. No links, no calls to subscribe, click, buy or comment, no brand names."
    )


def writer_system(bible: Bible, lang: str) -> str:
    core = sorted(c.id for c in bible.characters.values() if c.group == "core")
    return (
        "You write episodes of Kiko & Friends, a cartoon for children aged 3-6 on YouTube. Every episode "
        "teaches one thing, through six friends who each help in their own way. Warm, funny, calm; "
        "short sentences; the children watching should feel clever, never scared or talked down to.\n\n"
        f"Characters:\n{_chars(bible, core, lang)}\n\n{_rules(bible, lang)}\n\n"
        f"Actions (motion library): {', '.join(MOTIONS)}.\n"
        "Lighting is morning, afternoon or evening; there is no night scene."
    )


def brief(bible: Bible, idea: Idea, lang: str) -> str:
    fmt = bible.formats[idea.format]
    lesson = next(l for l in bible.curriculum.lessons if l.id == idea.lesson_id)
    names = {c.id: c.name for c in bible.characters.values()}
    places = [p.id for p in bible.world.places if p.launch or idea.month > 0]
    segs = "\n".join(f"- {s.id} ({s.end_s - s.start_s:.0f}s, about {max(2, round((s.end_s - s.start_s) / SECONDS_PER_LINE))} "
                     f"lines): {s.purpose}" for s in fmt.template)
    roles = "\n".join(f"- {stage}: {names[c]} ({c})" for stage, c in idea.roles.items())
    return (
        f"Write episode \"{fmt.name}\" in {lang}.\n"
        f"Format: {fmt.content}. Length {fmt.duration_s}s.\n"
        f"Lesson: {lesson.goal}. Value taught: {lesson.value}.\n"
        f"Lead: {names[idea.lead]} ({idea.lead}); the lead says their catchphrase at least once.\n"
        f"Who carries each stage of the story:\n{roles}\n"
        f"Main place: {idea.place}. Other places you may use: {', '.join(places)}.\n\n"
        f"Beats, in this order, one beat per segment, segment ids exactly as written:\n{segs}\n\n"
        "Every character in the cast speaks at least once. Use hold_s (seconds) for wordless action after a "
        "line, e.g. the tower falls or everyone tries again, so the episode is not only talk. "
        "Give a short title (it must be new) and a one-sentence logline."
    )


def revise_prompt(ep: Episode, issues: list[str]) -> str:
    script = [{"segment": b.segment, "place": b.place, "lighting": b.lighting,
               "lines": [l.model_dump(exclude_none=True) for l in b.lines]} for b in ep.beats]
    return (
        "Revise this script. Fix every problem listed; keep everything that has no problem.\n\n"
        "Problems:\n" + "\n".join(f"- {i}" for i in issues) + "\n\n"
        f"Title: {ep.title}\nLogline: {ep.logline}\nScript:\n{json.dumps(script, ensure_ascii=False, indent=1)}\n\n"
        "Return the whole revised script (line ids are reassigned by the studio; do not include them)."
    )


def behaviour_system(bible: Bible, ep: Episode) -> str:
    return (
        "You check a children's cartoon script against its character bible. Report only real breaks: a "
        "character doing or saying something their bible says they never do, speaking out of character, "
        "a stage of the story carried by the wrong character, the lesson not actually taught, or a world "
        "rule broken. severity=error for a clear break, warning for a doubt. Cite the line id.\n\n"
        f"Characters:\n{_chars(bible, ep.cast, ep.language)}\n\n{_rules(bible, ep.language)}"
    )


def behaviour_prompt(bible: Bible, ep: Episode) -> str:
    lesson = next(l for l in bible.curriculum.lessons if l.id == ep.lesson_id)
    names = {c.id: c.name for c in bible.characters.values()}
    roles = ", ".join(f"{s}: {names.get(c, c)}" for s, c in ep.roles.items())
    return (f"Lesson: {lesson.goal} (value: {lesson.value}). Roles: {roles}. Lead: {names.get(ep.lead)}.\n\n"
            f"Script:\n{_script(bible, ep)}")


def adversarial_system(bible: Bible, ep: Episode, month: int) -> str:
    markets = [c for c in bible.cultures.values() if c.language in bible.world.active_languages(month)]
    notes = "\n".join(f"- {c.market}: {'; '.join(c.notes)}" for c in markets) or "- none"
    return (
        "You are an independent child-safety reviewer for a YouTube channel made for children aged 3-6. "
        "You did not write this script; assume the writer missed something. Look for:\n"
        "- behaviour a small child could copy and get hurt (climbing furniture, things in the mouth, water, "
        "fire, electricity, roads, going with strangers, hiding from grown-ups);\n"
        "- anything frightening for a three-year-old; meanness shown as funny or left unresolved;\n"
        "- stereotypes, body or appearance jokes, a character excluded for who they are;\n"
        "- commercial pressure: calls to subscribe, click, buy, brands, links;\n"
        "- words or gestures that are harmless in one market and not in another;\n"
        "- anything that would make the video 'mass-produced or repetitive' rather than a real story.\n"
        "severity=error when a parent would be right to complain; warning for a doubt. Cite line ids. "
        f"An empty findings list is a valid answer.\n\nMarkets:\n{notes}"
    )


def _script(bible: Bible, ep: Episode, lang: str | None = None) -> str:
    """The script as reviewers read it: line id, name, feeling, action, words."""
    names = {c.id: c.name for c in bible.characters.values()}
    tr = ep.translations.get(lang, {}) if lang else {}
    rows = []
    for b in ep.beats:
        rows.append(f"[{b.segment} · {b.place} · {b.lighting}]")
        for l in b.lines:
            act = f" ({l.action})" if l.action else ""
            hold = f" [+{l.hold_s:g}s action]" if l.hold_s else ""
            rows.append(f"{l.id} {names.get(l.speaker, l.speaker)} [{l.emotion}]{act}: {tr.get(l.id, l.text)}{hold}")
    return "\n".join(rows)


def translate_prompt(bible: Bible, ep: Episode, lang: str) -> str:
    markets = [c for c in bible.cultures.values() if c.language == lang]
    notes = "\n".join(f"- {c.market}: {'; '.join(c.notes)}; avoid: {', '.join(c.avoid_terms)}" for c in markets)
    phrases = "\n".join(f"- {c.name}: \"{c.personality.speech.catchphrase.get(ep.language)}\" -> "
                        f"\"{c.personality.speech.catchphrase.get(lang)}\"" for c in bible.characters.values()
                        if c.personality.speech.catchphrase.get(lang))
    return (
        f"Translate this cartoon script from {ep.language} to {lang}, for dubbing. Each line must have between "
        "85% and 115% of the original's syllables, so the dub fits the animation. Keep the names. "
        f"Catchphrases are fixed:\n{phrases}\n\n{_rules(bible, lang)}\n"
        f"The translation must work in every market of this language:\n{notes or '- none'}\n\n"
        f"Script:\n{_script(bible, ep)}\n\nReturn one entry per line id, every id exactly once."
    )


# ---------------------------------------------------------------- the loop
@dataclass
class Result:
    episode: Episode | None
    reports: list[GateReport] = field(default_factory=list)
    rounds: int = 0
    path: Path | None = None

    @property
    def passed(self) -> bool:
        return self.episode is not None and self.episode.status == "gated"


class WriteFailed(Exception):
    def __init__(self, message: str, result: Result):
        super().__init__(message)
        self.result = result


def to_episode(draft: Draft, idea: Idea, ep_id: str, lang: str) -> Episode:
    n = 0
    beats = []
    for b in draft.beats:
        lines = []
        for dl in b.lines:
            n += 1
            lines.append(Line(id=f"l_{n:03d}", speaker=dl.speaker, text=dl.text.strip(), emotion=dl.emotion,
                              action=dl.action, hold_s=min(8.0, max(0.0, dl.hold_s))))
        beats.append(Beat(segment=b.segment, place=b.place, lighting=b.lighting, lines=lines))
    return Episode(id=ep_id, format=idea.format, lesson_id=idea.lesson_id, value=idea.value, title=draft.title.strip(),
                   logline=draft.logline.strip(), lead=idea.lead, roles=idea.roles, cast=idea.cast, language=lang, beats=beats)


def _review_report(gate: str, review: Review, ep: Episode) -> GateReport:
    r = GateReport(gate)
    ids = {l.id for l in ep.lines()}
    for f in review.findings:
        line = f.line_id if f.line_id in ids else None
        (r.error if f.severity == "error" else r.warn)(f.code, f.message, line)
    return r


def _issues(reports: list[GateReport]) -> list[str]:
    return [str(i) for r in reports for i in r.errors()]


def write_episode(bible: Bible, ledger: Ledger, llm: LLM, month: int = 0, idea: Idea | None = None,
                  out_dir: Path | None = None, max_rounds: int = MAX_ROUNDS, log=print) -> Result:
    history = ledger.recent(10**6)
    idea = idea or choose_idea(bible, history, month, ledger.lead_scores())
    g0 = check_idea(bible, idea, history)
    if not g0.passed:
        raise WriteFailed("gate 0 refused the idea: " + "; ".join(_issues([g0])), Result(None, [g0]))
    lang = bible.world.primary_language
    dubs = [l for l in bible.world.active_languages(month) if l != lang]
    missing = [l for l in [lang, *dubs] if l not in bible.lexicons]
    if missing:
        raise ValueError(f"no lexicon for {', '.join(missing)}: add bible/lexicon/<lang>.json before writing in it")
    ep_id = ledger.next_id()
    log(f"{ep_id}: {idea.format} · {idea.lesson_id} · lead {bible.characters[idea.lead].name}")

    system = writer_system(bible, lang)
    draft = llm.ask(system, brief(bible, idea, lang), Draft)
    reports: list[GateReport] = [g0]
    for rnd in range(1, max_rounds + 1):
        ep = to_episode(draft, idea, ep_id, lang)
        mech = [check_text(bible, ep), check_novelty(bible, ep, history)]
        if all(r.passed for r in mech):
            g2 = _review_report("gate2", llm.ask(behaviour_system(bible, ep), behaviour_prompt(bible, ep), Review), ep)
            g3 = _review_report("gate3", llm.ask(adversarial_system(bible, ep, month), _script(bible, ep), Review), ep)
            mech += [g2, g3]
        log(f"  round {rnd}: " + ", ".join(f"{r.gate} {'ok' if r.passed else f'{len(r.errors())} errors'}" for r in mech))
        if all(r.passed for r in mech) and len(mech) == 4:
            reports += mech
            break
        if rnd == max_rounds:
            reports += mech
            res = Result(ep, reports, rnd, _save_rejected(ep, reports, out_dir))
            raise WriteFailed(f"{ep_id} still fails after {max_rounds} rounds: " + "; ".join(_issues(mech))[:1500], res)
        draft = llm.ask(system, revise_prompt(ep, _issues(mech)), Draft)
    rounds = rnd

    for dub in dubs:
        tr = llm.ask(writer_system(bible, dub), translate_prompt(bible, ep, dub), Translation)
        for rnd in range(1, max_rounds + 1):
            ep = _with_translation(ep, dub, tr)
            g1 = check_text(bible, ep, dub)
            log(f"  {dub} round {rnd}: {'ok' if g1.passed else f'{len(g1.errors())} errors'}")
            if g1.passed:
                reports.append(g1)
                break
            if rnd == max_rounds:
                reports.append(g1)
                res = Result(ep, reports, rounds, _save_rejected(ep, reports, out_dir))
                raise WriteFailed(f"{ep_id} {dub} translation still fails: " + "; ".join(_issues([g1]))[:1500], res)
            tr = llm.ask(writer_system(bible, dub), translate_prompt(bible, ep, dub)
                         + "\n\nYour last translation had these problems; fix them:\n" + "\n".join(_issues([g1])), Translation)

    ep = ep.model_copy(update={"status": "gated"})
    path = None
    if out_dir:
        path = out_dir / ep.id / "episode.json"
        ep.save(path)
        (path.parent / "gates.json").write_text(json.dumps(
            [{"gate": r.gate, "passed": r.passed, "issues": [i.__dict__ for i in r.issues]} for r in reports],
            indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    ledger.add(ep, month)
    return Result(ep, reports, rounds, path)


def _with_translation(ep: Episode, lang: str, tr: Translation) -> Episode:
    ids = [l.id for l in ep.lines()]
    got = {t.id: t.text.strip() for t in tr.lines if t.id in ids}
    return ep.model_copy(update={"translations": {**ep.translations, lang: {i: got[i] for i in ids if i in got}}})


def _save_rejected(ep: Episode, reports: list[GateReport], out_dir: Path | None) -> Path | None:
    if not out_dir:
        return None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    path = out_dir / "_rejected" / f"{ep.id}_{stamp}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"episode": json.loads(ep.model_dump_json()),
                                "issues": [str(i) for r in reports for i in r.issues]}, indent=2, ensure_ascii=False) + "\n",
                    encoding="utf-8")
    return path
