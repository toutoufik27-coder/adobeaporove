"""Just enough ICC parsing to identify a color profile, without depending on LittleCMS.

A profile is identified by its measured primaries (the rXYZ/gXYZ/bXYZ tags), so compact or oddly
named sRGB profiles ("c2", "sRGB2014", "sRGB-elle-V2") are recognized as sRGB, and a wide-gamut
profile is caught whatever its name says.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

# D50-adapted primaries (X, Y, Z of red, green, blue) as ICC profiles store them.
_KNOWN = {
    "sRGB": ((0.4361, 0.2225, 0.0139), (0.3851, 0.7169, 0.0971), (0.1431, 0.0606, 0.7141)),
    "Adobe RGB": ((0.6097, 0.3111, 0.0195), (0.2053, 0.6257, 0.0609), (0.1492, 0.0632, 0.7446)),
    "Display P3": ((0.5151, 0.2412, -0.0011), (0.2920, 0.6922, 0.0419), (0.1571, 0.0666, 0.7841)),
    "ProPhoto RGB": ((0.7977, 0.2880, 0.0000), (0.1352, 0.7119, 0.0000), (0.0313, 0.0001, 0.8249)),
    "Rec. 2020": ((0.6734, 0.2790, -0.0019), (0.1656, 0.6753, 0.0300), (0.1251, 0.0457, 0.7970)),
}
_TOLERANCE = 0.012
_NAMES = (
    ("adobe rgb", "Adobe RGB"), ("adobergb", "Adobe RGB"), ("prophoto", "ProPhoto RGB"),
    ("display p3", "Display P3"), ("rec. 2020", "Rec. 2020"), ("rec.2020", "Rec. 2020"),
    ("wide gamut", "Wide Gamut RGB"),
)


@dataclass
class IccInfo:
    color_space: str  # "RGB", "CMYK", "GRAY", ...
    description: str
    primaries: tuple[tuple[float, float, float], ...] | None = None

    @property
    def measured(self) -> str:
        """The known color space the primaries match, or "" when there are none or no match."""
        if not self.primaries:
            return ""
        for name, ref in _KNOWN.items():
            if all(abs(a - b) <= _TOLERANCE for p, r in zip(self.primaries, ref, strict=True)
                   for a, b in zip(p, r, strict=True)):
                return name
        return ""

    @property
    def is_srgb(self) -> bool:
        if self.measured:
            return self.measured == "sRGB"
        d = self.description.lower().replace(" ", "")
        return "srgb" in d or "iec61966-2" in d

    @property
    def family(self) -> str:
        """A named non-sRGB space when the primaries or the description identify one."""
        if self.measured:
            return self.measured
        d = self.description.lower()
        for needle, name in _NAMES:
            if needle in d:
                return name
        return ""

    @property
    def label(self) -> str:
        return self.family or self.description or self.color_space


def parse_icc(data: bytes) -> IccInfo | None:
    if len(data) < 132:
        return None
    color_space = data[16:20].decode("ascii", "replace").strip()
    (count,) = struct.unpack(">I", data[128:132])
    tags: dict[bytes, bytes] = {}
    for i in range(min(count, 256)):
        entry = 132 + 12 * i
        if entry + 12 > len(data):
            break
        sig, offset, size = struct.unpack(">4sII", data[entry : entry + 12])
        tags[sig] = data[offset : offset + size]
    primaries = [_xyz(tags.get(t, b"")) for t in (b"rXYZ", b"gXYZ", b"bXYZ")]
    return IccInfo(
        color_space=color_space,
        description=_read_text(tags.get(b"desc", b"")),
        primaries=tuple(p for p in primaries if p) if all(primaries) else None,
    )


def _xyz(tag: bytes) -> tuple[float, float, float] | None:
    if len(tag) < 20 or tag[:4] != b"XYZ ":
        return None
    x, y, z = struct.unpack(">iii", tag[8:20])
    return (x / 65536, y / 65536, z / 65536)


def _read_text(tag: bytes) -> str:
    kind = tag[:4]
    if kind == b"desc" and len(tag) >= 12:
        (length,) = struct.unpack(">I", tag[8:12])
        return tag[12 : 12 + length].split(b"\0")[0].decode("latin-1").strip()
    if kind == b"mluc" and len(tag) >= 28:
        (records,) = struct.unpack(">I", tag[8:12])
        if records:
            length, offset = struct.unpack(">II", tag[20:28])
            return tag[offset : offset + length].decode("utf-16-be", "replace").strip("\0 ")
    if kind == b"text":
        return tag[8:].split(b"\0")[0].decode("latin-1").strip()
    return ""
