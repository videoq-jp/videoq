import json
import pathlib
import re


def inspect(report):
    if not isinstance(report.get("Results"), list):
        raise ValueError("Incomplete container report")
    details = set()
    reviewed = set()
    for result in report["Results"]:
        for entry in result.get("ExperimentalModifiedFindings", []):
            finding = entry["Finding"]
            if finding["Severity"] in ("HIGH", "CRITICAL"):
                reviewed.add(finding["VulnerabilityID"])
        for vuln in result.get("Vulnerabilities", []):
            if vuln["Severity"] not in ("HIGH", "CRITICAL"):
                continue
            safe = lambda value: re.sub(r"[^A-Za-z0-9_.:@/+~-]", "?", str(value))
            details.add("- " + safe(vuln["Severity"]) + " `" + safe(vuln["PkgName"]) + "@" +
                        safe(vuln["InstalledVersion"]) + "`: " + safe(vuln["VulnerabilityID"]) +
                        " / 修正版: " + safe(vuln.get("FixedVersion") or "未提供"))
    return {"status": "findings" if details else "ok",
            "summary": f"本番Lambdaの稼働中イメージに未評価のHIGH/CRITICALが{len(details)}件、適用条件を検証した評価済み検出が{len(reviewed)}件あります。",
            "details": sorted(details)}


if __name__ == "__main__":
    report = {"status": "error", "summary": "本番コンテナの脆弱性検査を完了できませんでした。", "details": []}
    try:
        report = inspect(json.loads(pathlib.Path("grype.json").read_text()))
    except Exception:
        pass
    pathlib.Path("operations-report.json").write_text(json.dumps(report, ensure_ascii=False))
