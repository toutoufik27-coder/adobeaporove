"""Gate 0: the idea, before any text is written. And the chooser that proposes an idea
that passes it: formats by their quotas, lessons not repeated, values balanced, and
the lead rotated through the six for the first ten episodes (problem 16)."""
from __future__ import annotations

import math

from ..bible.models import Bible
from ..episode import Idea
from ..ledger import Past
from . import GateReport

WINDOW = 20        # shares are measured over the last 20 episodes
FIRST_ROTATION = 10
STAGES = ("question", "rush", "caution", "failed_try", "emotion", "discovery")


def live_formats(bible: Bible, month: int) -> dict[str, float]:
    """Live formats with their quotas renormalised: at launch the one live format is 100 %."""
    live = {f.id: f.quota for f in bible.formats.values() if f.launch_month <= month}
    total = sum(live.values())
    return {k: v / total for k, v in live.items()}


def allowed_in_window(share: float) -> int:
    return max(1, math.ceil(share * WINDOW))


def core_ids(bible: Bible) -> list[str]:
    return sorted(c.id for c in bible.characters.values() if c.group == "core")


def leads_this_cycle(bible: Bible, history: list[Past]) -> set[str]:
    """Leads of the round in progress. Rounds are counted from the first episode: a round
    ends when all six have led (history is most recent first)."""
    core, seen = set(core_ids(bible)), set()
    for p in reversed(history):
        if p.lead in core:
            seen.add(p.lead)
            if seen == core:
                seen = set()
    return seen


def check_idea(bible: Bible, idea: Idea, history: list[Past]) -> GateReport:
    r = GateReport("gate0")
    w = bible.world
    fmt = bible.formats.get(idea.format)
    live = live_formats(bible, idea.month)
    if not fmt:
        r.error("format.unknown", f"no format {idea.format}")
    elif idea.format not in live:
        r.error("format.not_live", f"{idea.format} goes live in month {fmt.launch_month}, this is month {idea.month}")
    lesson = next((l for l in bible.curriculum.lessons if l.id == idea.lesson_id), None)
    if not lesson:
        r.error("lesson.unknown", f"no lesson {idea.lesson_id}")
    else:
        if idea.format not in lesson.formats:
            r.error("lesson.format", f"{lesson.id} is not a {idea.format} lesson")
        if idea.value != lesson.value:
            r.error("lesson.value", f"{lesson.id} teaches {lesson.value}, not {idea.value}")
    window = history[: WINDOW - 1]
    if any(p.lesson_id == idea.lesson_id for p in history[: w.lesson_repeat_window]):
        r.error("lesson.repeat", f"{idea.lesson_id} was used in the last {w.lesson_repeat_window} episodes")
    value_cap = max(1, math.floor(w.max_value_share * WINDOW))
    n_value = sum(p.value == idea.value for p in window) + 1
    if n_value > value_cap:
        r.error("value.share", f"{idea.value} would be {n_value} of the last {WINDOW} episodes (max {value_cap})")
    if idea.format in live:
        cap = allowed_in_window(live[idea.format])
        n_fmt = sum(p.format == idea.format for p in window) + 1
        if n_fmt > cap:
            r.error("format.share", f"{idea.format} would be {n_fmt} of the last {WINDOW} episodes (quota {cap})")

    core = set(core_ids(bible))
    if idea.lead not in core:
        r.error("cast.lead", f"lead {idea.lead} is not a core character")
    for c in idea.cast:
        if c not in bible.characters:
            r.error("cast.unknown", f"no character {c}")
    if idea.lead not in idea.cast:
        r.error("cast.lead", "the lead must be in the cast")
    if set(idea.roles) != set(STAGES):
        r.error("cast.roles", f"roles must cover exactly {', '.join(STAGES)}")
    for stage, ch in idea.roles.items():
        if ch not in idea.cast:
            r.error("cast.roles", f"{stage} is given to {ch}, who is not in the cast")
    if idea.roles.get("question") != idea.lead:
        r.warn("cast.roles", "the lead usually asks the question that starts the episode")

    if len(history) < FIRST_ROTATION:
        if idea.lead in leads_this_cycle(bible, history):
            r.error("lead.rotation", f"the first {FIRST_ROTATION} episodes rotate the lead through the six; {idea.lead} already led this round")
    elif sum(p.lead == idea.lead for p in history[:5]) >= 3:
        r.warn("lead.balance", f"{idea.lead} led 3 of the last 5 episodes")

    place = next((p for p in w.places if p.id == idea.place), None)
    if not place:
        r.error("place.unknown", f"no place {idea.place}")
    elif not place.launch and idea.month == 0:
        r.error("place.not_ready", f"{idea.place} is not one of the launch places")
    return r


def default_roles(bible: Bible, lead: str) -> dict[str, str]:
    """Each stage to the character who leads it by default; the lead asks the question and
    whoever usually asks takes the lead's stage (a free variation per episode)."""
    roles = {c.lead_stage: c.id for c in bible.characters.values() if c.group == "core" and c.lead_stage in STAGES}
    asker = roles.get("question")
    lead_stage = bible.characters[lead].lead_stage
    if asker and asker != lead and lead_stage in roles:
        roles[lead_stage], roles["question"] = asker, lead
    return roles


def choose_idea(bible: Bible, history: list[Past], month: int, scores: dict[str, tuple[int, float, float]] | None = None) -> Idea:
    """The next idea that passes gate 0 (history: most recent first)."""
    live = live_formats(bible, month)
    window = history[: WINDOW - 1]
    w = bible.world
    value_cap = max(1, math.floor(w.max_value_share * WINDOW))
    recent_lessons = {p.lesson_id for p in history[: w.lesson_repeat_window]}

    def usable(lesson, fmt):
        return (fmt in lesson.formats and lesson.id not in recent_lessons
                and sum(p.value == lesson.value for p in window) + 1 <= value_cap)

    def deficit(fid):  # how far below its share the format is
        return live[fid] - sum(p.format == fid for p in window) / max(1, len(window))

    for fmt in sorted(live, key=lambda f: (-deficit(f), -live[f], f)):
        if sum(p.format == fmt for p in window) + 1 > allowed_in_window(live[fmt]):
            continue
        lessons = [l for l in bible.curriculum.lessons if usable(l, fmt)]
        if not lessons:
            continue
        # never used first, in curriculum order; then the one used longest ago
        last_use = {p.lesson_id: i for i, p in reversed(list(enumerate(history)))}
        order = {l.id: k for k, l in enumerate(bible.curriculum.lessons)}
        lesson = min(lessons, key=lambda l: (-(last_use.get(l.id, 10**9)), order[l.id]))
        break
    else:
        raise ValueError("no lesson can be used without breaking gate 0: add lessons to the curriculum")

    core = core_ids(bible)
    if len(history) < FIRST_ROTATION:
        done = leads_this_cycle(bible, history)
        lead = next(c for c in core if c not in done)
    else:
        # the published numbers decide first (mean view %); without them the rounds go on
        recent = [p.lead for p in history[:2]]
        scores = scores or {}
        done = leads_this_cycle(bible, history)
        lead = min((c for c in core if c not in recent),
                   key=lambda c: (-(scores.get(c, (0, 0.0, 0.0))[1]), c in done,
                                  sum(p.lead == c for p in history[:10]), c))
    launch = [p.id for p in w.places if p.launch or month > 0]
    place = launch[len(history) % len(launch)]
    return Idea(format=fmt, lesson_id=lesson.id, value=lesson.value, lead=lead, roles=default_roles(bible, lead),
                cast=core, place=place, month=month)


def simulate(bible: Bible, episodes: int, month_of=lambda n: 0) -> list[Idea]:
    """Plan `episodes` ideas in a row (month_of(n) gives the production month of the n-th).
    Raises ValueError when the curriculum runs out: the bible check calls this so a thin
    curriculum is found at design time, not in month seven."""
    history: list[Past] = []
    out = []
    for n in range(episodes):
        try:
            idea = choose_idea(bible, history, month_of(n))
        except ValueError as e:
            raise ValueError(f"episode {n + 1}: {e}") from e
        report = check_idea(bible, idea, history)
        if not report.passed:
            raise ValueError(f"episode {n + 1}: the chooser proposed an idea gate 0 rejects: {report.errors()}")
        out.append(idea)
        history.insert(0, Past(f"ep_{n + 1:04d}", idea.format, idea.lesson_id, idea.value, idea.lead, "", ""))
    return out
