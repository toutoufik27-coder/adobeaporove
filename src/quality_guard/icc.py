"""Just enough ICC parsing to name a profile, without depending on LittleCMS."""

from __future__ import annotations

import struct
from dataclasses import dataclass


@dataclass
class IccInfo:
    color_space: str  # "RGB", "CMYK", "GRAY", ...
    description: str

    @property
    def is_srgb(self) -> bool:
        d = self.description.lower().replace(" ", "")
        return "srgb" in d or "iec61966-2" in d or "iec61966-2.1" in d

    @property
    def family(self) -> str:
        d = self.description.lower()
        for needle, name in (
            ("adobe rgb", "Adobe RGB"),
            ("adobergb", "Adobe RGB"),
            ("prophoto", "ProPhoto RGB"),
            ("display p3", "Display P3"),
            ("p3", "Display P3"),
            ("rec. 2020", "Rec. 2020"),
            ("rec.2020", "Rec. 2020"),
            ("wide gamut", "Wide Gamut RGB"),
        ):
            if needle in d:
                return name
        return self.description or self.color_space


def parse_icc(data: bytes) -> IccInfo | None:
    if len(data) < 132:
        return None
    color_space = data[16:20].decode("ascii", "replace").strip()
    (count,) = struct.unpack(">I", data[128:132])
    description = ""
    for i in range(min(count, 256)):
        entry = 132 + 12 * i
        if entry + 12 > len(data):
            break
        sig, offset, size = struct.unpack(">4sII", data[entry : entry + 12])
        if sig == b"desc":
            description = _read_text(data[offset : offset + size])
            break
    return IccInfo(color_space=color_space, description=description)


def _read_text(tag: bytes) -> str:
    kind = tag[:4]
    if kind == b"desc" and len(tag) >= 12:
        (length,) = struct.unpack(">I", tag[8:12])
        return tag[12 : 12 + length].split(b"\0")[0].decode("latin-1").strip()
    if kind == b"mluc" and len(tag) >= 16:
        (records,) = struct.unpack(">I", tag[8:12])
        if records and len(tag) >= 28:
            length, offset = struct.unpack(">II", tag[20:28])
            return tag[offset : offset + length].decode("utf-16-be", "replace").strip("\0 ")
    if kind == b"text":
        return tag[8:].split(b"\0")[0].decode("latin-1").strip()
    return ""
