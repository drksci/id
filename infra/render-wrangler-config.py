#!/usr/bin/env python3
"""Render the Wrangler template for ONE target environment.

D0 fix for drksci/id. The previous revision required all four D1 IDs on every run, so a `prod`
deploy failed with `D1_DATABASE_ID_DEV must be a UUID-shaped deployment variable` — it named an
environment nobody was deploying, and said nothing about how to fix it.

Changes:
  * `--env` selects the target, and only that environment's variable is required.
  * A missing or malformed variable fails with an actionable message naming the variable, the
    environment, and the exact command that sets it (RULES.md R9).
  * Placeholders belonging to non-target environments are left untouched, so the file stays valid
    TOML and remains deployable for those environments by a separate run.
  * `--check` reports what is missing and exits 1 without writing anything, for use as a preflight.
"""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path

ENVIRONMENTS = ("prod", "dev", "test", "preview")
UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)
PLACEHOLDER = re.compile(r"\$\{D1_DATABASE_ID_([A-Z]+)\}")


def variable_for(environment: str) -> str:
    return f"D1_DATABASE_ID_{environment.upper()}"


def render(template_path: Path, output_path: Path | None, environment: str, check_only: bool = False) -> str:
    if environment not in ENVIRONMENTS:
        raise SystemExit(
            f"unsupported environment: {environment!r}\n"
            f"  choose one of: {', '.join(ENVIRONMENTS)}"
        )

    template = template_path.read_text(encoding="utf-8")
    required = variable_for(environment)
    value = os.environ.get(required, "")

    if not UUID_PATTERN.fullmatch(value):
        state = "is not set" if not value else f"is not a UUID (got {value!r})"
        raise SystemExit(
            f"cannot render the {environment} deployment: {required} {state}.\n"
            f"\n"
            f"  fix:  gh variable set {required} --env {environment} --body <database-uuid>\n"
            f"        npx wrangler@4 d1 create id-data-{environment}   # if it does not exist yet\n"
            f"\n"
            f"  only the target environment's id is needed; the other {len(ENVIRONMENTS) - 1} are not read."
        )

    rendered = template.replace(f"${{{required}}}", value)

    if check_only:
        remaining = sorted({m.group(1) for m in PLACEHOLDER.finditer(rendered)})
        if environment.upper() in remaining:
            raise SystemExit(f"internal error: {required} still unresolved after substitution")
        return rendered

    if output_path is None:
        raise SystemExit("--output is required unless --check is used")

    output_path.write_text(rendered, encoding="utf-8")
    leftover = sorted({m.group(1) for m in PLACEHOLDER.finditer(rendered)})
    if leftover:
        # Informational only: those environments are not being deployed by this run.
        print(f"note: left {len(leftover)} other environment placeholder(s) untouched: {', '.join(leftover)}")
    return rendered


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, help="where to write the rendered config")
    parser.add_argument("--env", default="prod", choices=ENVIRONMENTS, help="target environment (default: prod)")
    parser.add_argument("--check", action="store_true", help="validate only; write nothing")
    args = parser.parse_args()

    if not args.check and args.output is None:
        parser.error("--output is required unless --check is used")

    render(Path(__file__).with_name("wrangler.toml"), args.output, args.env, args.check)
    if not args.check:
        print(f"rendered {args.env} config -> {args.output}")


if __name__ == "__main__":
    main()
