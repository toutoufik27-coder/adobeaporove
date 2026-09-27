"""The words the voices are made and checked with: the 50 test lines per language of the
definition of done (questions, exclamations, statements), a 15-second passage for each
dub reference, and lines that carry a feeling for the emotional references."""
from __future__ import annotations

REF_SENTENCES_EN = [
    "Hello, friends! Today we are going to find out something new.",
    "Hmm, what is inside this little box? Let's look together!",
    "Ha ha! That tickles! Can we do it again, please?",
]

EMOTION_LINES = {  # feeling -> (line, change to the character's exaggeration)
    "happy": ("Yay! We did it together! This is the best day ever!", 0.3),
    "sad": ("Oh… my tower fell down. I feel a little sad now.", -0.2),
    "surprised": ("Whoa! Did you see that? It just jumped out of the box!", 0.4),
}

_EN_THINGS = ["red ball", "big tower", "little boat", "yellow kite", "blue box", "green leaf", "funny hat",
              "tall tree", "soft pillow", "shiny shell"]
_EN_PATTERNS = ["Look at the {t}!", "Where did the {t} go?", "I really like this {t}.",
                "Can we find the {t} together?", "Oh no, the {t} is stuck up there!"]

_ES_THINGS = [("pelota roja", "f"), ("torre grande", "f"), ("barquito", "m"), ("cometa amarilla", "f"),
              ("caja azul", "f"), ("hoja verde", "f"), ("sombrero gracioso", "m"), ("árbol alto", "m"),
              ("almohada suave", "f"), ("caracola brillante", "f")]  # not "concha": vulgar in parts of Latin America
_ES_PATTERNS = ["¡Fíjate en {el} {t}!", "¿Adónde se fue {el} {t}?", "Me gusta mucho {este} {t}.",
                "¿Buscamos {el} {t} juntos?", "¡Ay, no! ¡{El} {t} se quedó arriba!"]

PASSAGES = {  # about 15 seconds each, for the dub references
    "es": "¡Hola! Hoy vamos a descubrir algo nuevo. ¿Qué será? Primero miramos con cuidado, después preguntamos, "
          "y al final lo intentamos juntos. ¡Qué divertido es aprender con amigos! ¿Estás listo? ¡Vamos!",
    "pt": "Olá! Hoje vamos descobrir uma coisa nova. O que será? Primeiro olhamos com cuidado, depois perguntamos, "
          "e no fim tentamos juntos. Como é divertido aprender com amigos! Está pronto? Vamos lá!",
    "fr": "Bonjour ! Aujourd'hui, on va découvrir quelque chose de nouveau. Qu'est-ce que c'est ? D'abord, on regarde "
          "bien, ensuite on pose des questions, et à la fin, on essaie ensemble. C'est si amusant d'apprendre avec des "
          "amis ! Tu es prêt ? On y va !",
    "de": "Hallo! Heute entdecken wir etwas Neues. Was kann das sein? Zuerst schauen wir genau hin, dann fragen wir, "
          "und am Ende probieren wir es zusammen. Mit Freunden lernen macht so viel Spaß! Bist du bereit? Los geht's!",
    "ar": "مرحبًا! اليوم سنكتشف شيئًا جديدًا. ما هو يا ترى؟ أولًا ننظر بانتباه، ثم نسأل، وفي النهاية نحاول معًا. "
          "ما أجمل التعلم مع الأصدقاء! هل أنت مستعد؟ هيا بنا!",
}


def validation_lines(lang: str) -> list[str]:
    if lang == "en":
        return [p.format(t=t) for t in _EN_THINGS for p in _EN_PATTERNS]
    if lang == "es":
        out = []
        for t, g in _ES_THINGS:
            words = {"el": "el" if g == "m" else "la", "El": "El" if g == "m" else "La", "este": "este" if g == "m" else "esta"}
            out += [p.format(t=t, **words) for p in _ES_PATTERNS]
        return out
    raise KeyError(f"no test lines for {lang}: add them to studio/agent/lines.py")


def passage(lang: str) -> str:
    if lang not in PASSAGES:
        raise KeyError(f"no reference passage for {lang}: add one to studio/agent/lines.py")
    return PASSAGES[lang]
