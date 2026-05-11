#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
from typing import Any


def read_json(path: pathlib.Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_local_oci(layout_dir: pathlib.Path) -> dict[str, Any]:
    index = read_json(layout_dir / "index.json")
    manifest_desc = index["manifests"][0]
    manifest_digest = manifest_desc["digest"].split(":", 1)[1]
    manifest = read_json(layout_dir / "blobs" / "sha256" / manifest_digest)
    config_digest = manifest["config"]["digest"].split(":", 1)[1]
    config = read_json(layout_dir / "blobs" / "sha256" / config_digest)
    return {
        "config_digest": manifest["config"]["digest"],
        "architecture": config.get("architecture"),
        "os": config.get("os"),
        "diff_ids": config.get("rootfs", {}).get("diff_ids", []),
        "history": config.get("history", []),
        "manifest_layers": [layer["digest"] for layer in manifest.get("layers", [])],
    }


def load_published_image(image_ref: str) -> dict[str, Any]:
    inspect = json.loads(
        subprocess.check_output(
            ["docker", "image", "inspect", image_ref],
            text=True,
        )
    )[0]
    return {
        "config_digest": inspect["Id"],
        "architecture": inspect.get("Architecture"),
        "os": inspect.get("Os"),
        "diff_ids": inspect.get("RootFS", {}).get("Layers", []),
        "history": inspect.get("History", []),
    }


def non_empty_history(history: list[dict[str, Any]]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for entry in history:
        if entry.get("empty_layer"):
            continue
        rows.append(
            {
                "created_by": entry.get("created_by", ""),
                "comment": entry.get("comment", ""),
            }
        )
    return rows


def shorten(text: str, limit: int = 120) -> str:
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def main() -> int:
    parser = argparse.ArgumentParser(description="Diff published and local OCI image layers.")
    parser.add_argument("--service", required=True)
    parser.add_argument("--published-image-ref", required=True)
    parser.add_argument("--local-oci-layout", required=True)
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--output-md", required=True)
    args = parser.parse_args()

    local = load_local_oci(pathlib.Path(args.local_oci_layout))
    published = load_published_image(args.published_image_ref)
    local_history = non_empty_history(local["history"])
    published_history = non_empty_history(published["history"])

    layer_rows = []
    max_layers = max(len(local["diff_ids"]), len(published["diff_ids"]))
    first_mismatch: dict[str, Any] | None = None

    for idx in range(max_layers):
        published_diff = published["diff_ids"][idx] if idx < len(published["diff_ids"]) else ""
        local_diff = local["diff_ids"][idx] if idx < len(local["diff_ids"]) else ""
        published_step = published_history[idx]["created_by"] if idx < len(published_history) else ""
        local_step = local_history[idx]["created_by"] if idx < len(local_history) else ""
        row = {
            "layer_index": idx,
            "published_diff_id": published_diff,
            "local_diff_id": local_diff,
            "published_step": published_step,
            "local_step": local_step,
            "match": published_diff == local_diff,
        }
        if not row["match"] and first_mismatch is None:
            first_mismatch = row
        layer_rows.append(row)

    payload = {
        "service": args.service,
        "published_image_ref": args.published_image_ref,
        "published_config_digest": published["config_digest"],
        "local_config_digest": local["config_digest"],
        "published_architecture": published["architecture"],
        "local_architecture": local["architecture"],
        "published_os": published["os"],
        "local_os": local["os"],
        "first_mismatch": first_mismatch,
        "layers": layer_rows,
    }

    json_path = pathlib.Path(args.output_json)
    md_path = pathlib.Path(args.output_md)
    json_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    lines = [
        f"## Layer Diff: `{args.service}`",
        "",
        f"Published image: `{args.published_image_ref}`",
        f"Published config: `{published['config_digest']}`",
        f"Local rebuild config: `{local['config_digest']}`",
        f"Published platform: `{published['os']}/{published['architecture']}`",
        f"Local platform: `{local['os']}/{local['architecture']}`",
    ]

    if first_mismatch is not None:
        lines.extend(
            [
                "",
                f"First mismatching layer index: `{first_mismatch['layer_index']}`",
                f"Published step: `{shorten(first_mismatch['published_step'])}`",
                f"Local step: `{shorten(first_mismatch['local_step'])}`",
            ]
        )

    lines.extend(
        [
            "",
            "| Layer | Published diff_id | Local diff_id | Match | Step |",
            "| --- | --- | --- | --- | --- |",
        ]
    )

    for row in layer_rows:
        step = row["local_step"] or row["published_step"]
        lines.append(
            f"| `{row['layer_index']}` | `{row['published_diff_id']}` | `{row['local_diff_id']}` | "
            f"`{'yes' if row['match'] else 'no'}` | `{shorten(step)}` |"
        )

    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
