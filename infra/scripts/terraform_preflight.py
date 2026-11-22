"""Gate approval on a successful read-only plan, without publishing its values."""
import os
import json
import re
from pathlib import Path
import subprocess
import sys
import tempfile


def review_metadata(plan):
    """Publish only provider/schema identifiers; omit values and instance keys."""
    groups = {}
    changes = plan.get("resource_changes", [])
    if not isinstance(changes, list):
        raise ValueError("Invalid plan metadata")
    def unknown(value):
        if isinstance(value, dict):
            return any(unknown(item) for item in value.values())
        if isinstance(value, list):
            return any(unknown(item) for item in value)
        return value is True
    for row in changes:
        if row.get("mode") not in {"data", "managed"}:
            raise ValueError("Unsupported resource mode")
        change = row["change"]
        actions = change["actions"]
        if actions == ["no-op"]:
            continue
        resource_type, name = row["type"], row["name"]
        if (not re.fullmatch(r"[a-z][a-z0-9_]{0,100}", resource_type)
                or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,100}", name)
                or not isinstance(actions, list) or not actions
                or any(action not in {"create", "read", "update", "delete", "forget"} for action in actions)):
            raise ValueError("Unsupported plan metadata")
        before, after, pending = (change.get(key) or {} for key in ("before", "after", "after_unknown"))
        if not all(isinstance(value, dict) for value in (before, after, pending)):
            raise ValueError("Unsupported attributes")
        attributes = sorted(key for key in before.keys() | after.keys() | pending.keys()
                            if before.get(key) != after.get(key) or unknown(pending.get(key)))
        if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,100}", key) for key in attributes):
            raise ValueError("Unsupported attribute identifier")
        key = (("data." if row["mode"] == "data" else "") + resource_type + "." + name, tuple(actions), tuple(attributes))
        groups[key] = groups.get(key, 0) + 1
    outputs = plan.get("output_changes", {})
    if not isinstance(outputs, dict):
        raise ValueError("Invalid output metadata")
    output_count = sum(value["actions"] != ["no-op"] for value in outputs.values())
    if not groups and not output_count:
        raise ValueError("Missing changed resource metadata")
    lines = ["Resource | Instances | Actions | Changed attributes", "--- | ---: | --- | ---"]
    for (resource, actions, attributes), count in sorted(groups.items()):
        lines.append(f"{resource} | {count} | {', '.join(actions)} | {', '.join(attributes) or '(none)'}")
    lines.append(f"Changed outputs: {output_count} (names and values omitted).")
    return "\n".join(lines)


def main():
    try:
        # The binary plan can contain secrets. Keep it in a private temporary
        # directory, never upload it, and delete it even when parsing fails.
        with tempfile.TemporaryDirectory(prefix="videoq-preflight-") as directory:
            saved = str(Path(directory) / "review.tfplan")
            result = subprocess.run(
                ["terraform", "plan", "-json", "-input=false", "-no-color",
                 "-lock-timeout=60s", "-detailed-exitcode", "-out=" + saved],
                capture_output=True,
            )
            metadata = ""
            if result.returncode == 2:
                inspected = subprocess.run(["terraform", "show", "-json", saved], capture_output=True)
                if inspected.returncode != 0:
                    raise ValueError("Plan inspection failed")
                metadata = review_metadata(json.loads(inspected.stdout))
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        print("Unable to inspect Terraform preflight. Approval and apply are blocked.", file=sys.stderr)
        return 1

    # Neither stdout nor stderr is public: provider diagnostics and plan values
    # can contain secrets. A failure must not be mistaken for an empty plan.
    if result.returncode not in (0, 2):
        print(f"Terraform preflight failed (exit {result.returncode}). "
              "Approval and apply are blocked; inspect a plan privately.", file=sys.stderr)
        return 1

    changes = result.returncode == 2
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"has_changes={str(changes).lower()}\n")
    summary = (
        "Terraform detected changes. The existing approval or verified dependency update policy applies."
        if changes else
        "Terraform found no changes. Approval and apply are skipped; "
        "this run succeeds without creating a production-infra deployment."
    )
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as output:
        output.write(summary + "\n")
        if metadata:
            output.write("\n" + metadata + "\n")
    print(summary)
    if metadata:
        print(metadata)
    return 0


if __name__ == "__main__":
    sys.exit(main())
