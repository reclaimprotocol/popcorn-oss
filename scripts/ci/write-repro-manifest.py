#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import pathlib
from datetime import UTC, datetime


def build_image_ref(host: str, project: str, repository: str, image: str, digest: str) -> str:
    return f"{host}/{project}/{repository}/{image}@{digest}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Write the reproducible image manifest for browser-runtime-attestor and browser-runtime.")
    parser.add_argument("--commit", required=True)
    parser.add_argument("--source-date-epoch", required=True, type=int)
    parser.add_argument("--registry-host", required=True)
    parser.add_argument("--registry-project", required=True)
    parser.add_argument("--registry-repository", required=True)
    parser.add_argument("--browser-runtime-attestor-digest", required=True)
    parser.add_argument("--browser-runtime-digest", required=True)
    parser.add_argument("--browser-base-digest", required=True)
    parser.add_argument("--browser-base-tag", required=True)
    parser.add_argument("--artifact-mirror-tag", required=True)
    parser.add_argument("--submodule-sha", required=True)
    parser.add_argument("--json-out", required=True)
    parser.add_argument("--markdown-out", required=True)
    args = parser.parse_args()

    created_at = datetime.fromtimestamp(args.source_date_epoch, tz=UTC).isoformat().replace("+00:00", "Z")
    tag_prefix = f"{args.registry_host}/{args.registry_project}/{args.registry_repository}"

    payload = {
        "commit": args.commit,
        "source_date_epoch": args.source_date_epoch,
        "created_at": created_at,
        "tag_policy": "immutable commit tags",
        "reproducible_images": {
            "browser-runtime-attestor": {
                "tag": f"{tag_prefix}/browser-runtime-attestor:{args.commit}",
                "digest": args.browser_runtime_attestor_digest,
                "image": build_image_ref(
                    args.registry_host,
                    args.registry_project,
                    args.registry_repository,
                    "browser-runtime-attestor",
                    args.browser_runtime_attestor_digest,
                ),
            },
            "browser-runtime": {
                "tag": f"{tag_prefix}/browser-runtime:{args.commit}",
                "digest": args.browser_runtime_digest,
                "image": build_image_ref(
                    args.registry_host,
                    args.registry_project,
                    args.registry_repository,
                    "browser-runtime",
                    args.browser_runtime_digest,
                ),
                "browser_base": {
                    "tag": f"{tag_prefix}/browser-base:{args.browser_base_tag}",
                    "digest": args.browser_base_digest,
                    "image": build_image_ref(
                        args.registry_host,
                        args.registry_project,
                        args.registry_repository,
                        "browser-base",
                        args.browser_base_digest,
                    ),
                },
                "artifact_mirror_tag": args.artifact_mirror_tag,
                "submodule_sha": args.submodule_sha,
            },
        },
    }

    json_out = pathlib.Path(args.json_out)
    markdown_out = pathlib.Path(args.markdown_out)
    json_out.parent.mkdir(parents=True, exist_ok=True)
    markdown_out.parent.mkdir(parents=True, exist_ok=True)
    json_out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    markdown = f"""## Reproducible Images

This build records immutable digests for the reproducible image set only: `browser-runtime-attestor` and `browser-runtime`.

Commit: `{args.commit}`
Source date epoch: `{args.source_date_epoch}` (`{created_at}`)
Tag policy: immutable commit tags

| Image | Commit tag | Digest ref |
| --- | --- | --- |
| `browser-runtime-attestor` | `{tag_prefix}/browser-runtime-attestor:{args.commit}` | `{payload["reproducible_images"]["browser-runtime-attestor"]["image"]}` |
| `browser-runtime` | `{tag_prefix}/browser-runtime:{args.commit}` | `{payload["reproducible_images"]["browser-runtime"]["image"]}` |
| `browser-base` | `{tag_prefix}/browser-base:{args.browser_base_tag}` | `{payload["reproducible_images"]["browser-runtime"]["browser_base"]["image"]}` |

Browser runtime submodule SHA: `{args.submodule_sha}`
Chromium artifact mirror tag: `{args.artifact_mirror_tag}`
"""
    markdown_out.write_text(markdown, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
