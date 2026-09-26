from __future__ import annotations

import pytest
from imagegen import natural_rgb
from PIL import Image


@pytest.fixture(scope="session")
def photo() -> Image.Image:
    return Image.fromarray(natural_rgb(1800, 2400))
