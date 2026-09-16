#!/usr/bin/env python3
"""Render the Wrangler template using deployment-owned D1 IDs.

The checked-in TOML uses explicit ${D1_DATABASE_ID_*} references because Wrangler requires literal
UUIDs and does not interpolate process environment variables in TOML. CI writes the rendered file
to a temporary path beside this config, then removes it after deployment.
"""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path


DATABASE_VARIABLES = (
    "D1_DATABASE_ID_PROD",
    "D1_DATABASE_ID_DEV",
    "D1_DATABASE_ID_TEST",
    "D1_DATABASE_ID_PREVIEW",
)
UUID_PATTERN = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")


def render(template_path: Path, output_path: Path) -> None:
    rendered = template_path.read_text(encoding="utf-8")
    for variable in DATABASE_VARIABLES:
        value = os.environ.get(variable, "")
        if not UUID_PATTERN.fullmatch(value):
            raise SystemExit(f"{variable} must be a UUID-shaped deployment variable")
        rendered = rendered.replace(f"${{{variable}}}", value)
    unresolved = re.search(r"\$\{D1_DATABASE_ID_(?:PROD|DEV|TEST|PREVIEW)\}", rendered)
    if unresolved:
        raise SystemExit("unresolved D1 database variable")
    output_path.write_text(rendered, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    render(Path(__file__).with_name("wrangler.toml"), args.output)


if __name__ == "__main__":
    main()
