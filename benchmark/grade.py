"""Manual quality grades and cost analysis for an executed Pace benchmark."""

import argparse
import json
from collections import Counter
from pathlib import Path
from statistics import median


def load_runs(root: Path):
    runs = {}
    for path in sorted(root.glob("*/*/*/run.json")):
        run = json.loads(path.read_text(encoding="utf-8"))
        key = (run["id"], run["repetition"], run["arm"])
        if key in runs:
            raise ValueError(f"Duplicate run: {key}")
        runs[key] = (run, path)
    if not runs:
        raise ValueError(f"No run.json files found in {root}")
    return runs


def prepare(root: Path, runs):
    path = root / "grades.json"
    if path.exists():
        raise ValueError(f"Grades already exist; refusing to overwrite {path}")
    entries = []
    for (case, repetition, arm), (run, run_path) in sorted(runs.items()):
        entries.append({
            "id": case,
            "repetition": repetition,
            "arm": arm,
            "runFile": run_path.relative_to(root).as_posix(),
            "promptSha256": run["promptSha256"],
            "commit": run["commit"],
            "rubric": run.get("rubric"),
            "checksPassed": all(check["exitCode"] == 0 for check in run.get("checks", [])),
            "pass": None,
            "notes": "",
        })
    path.write_text(json.dumps({"version": 1, "runs": entries}, indent=2) + "\n", encoding="utf-8")
    print(f"Review answers and diffs, then fill pass=true/false in {path} ({len(entries)} runs).")


def tokens(run):
    usage = run.get("usage")
    return None if not usage else {
        "raw": usage["input_tokens"] + usage["output_tokens"],
        "input": usage["input_tokens"],
        "cachedInput": usage["cached_input_tokens"],
        "cacheWriteInput": usage["cache_write_input_tokens"],
        "output": usage["output_tokens"],
        "reasoningOutput": usage["reasoning_output_tokens"],
    }


def score(root: Path, runs):
    grades = json.loads((root / "grades.json").read_text(encoding="utf-8"))
    if grades.get("version") != 1 or not isinstance(grades.get("runs"), list):
        raise ValueError("grades.json must contain version 1 and runs")
    marked = {}
    for entry in grades["runs"]:
        key = (entry["id"], entry["repetition"], entry["arm"])
        if key not in runs or key in marked:
            raise ValueError(f"Missing or duplicate run: {key}")
        run, path = runs[key]
        if entry["runFile"] != path.relative_to(root).as_posix() or entry["promptSha256"] != run["promptSha256"] or entry["commit"] != run["commit"]:
            raise ValueError(f"Run identity changed: {key}")
        if type(entry.get("pass")) is not bool:
            raise ValueError(f"Set pass=true or false for {key}")
        marked[key] = entry
    if set(marked) != set(runs):
        raise ValueError("grades.json does not cover every run")

    def passed(key):
        run = runs[key][0]
        return marked[key]["pass"] and not run.get("error") and all(check["exitCode"] == 0 for check in run.get("checks", []))

    arms = sorted({key[2] for key in runs})
    arm_quality = {arm: {"passed": sum(passed(key) for key in runs if key[2] == arm),
                         "total": sum(key[2] == arm for key in runs)} for arm in arms}
    comparisons = {}
    for arm in arms:
        if arm == "baseline":
            continue
        pairs = []
        for (case, repetition, candidate), (run, _) in sorted(runs.items()):
            if candidate != arm:
                continue
            baseline_key = (case, repetition, "baseline")
            if baseline_key not in runs or not passed(baseline_key) or not passed((case, repetition, arm)):
                continue
            baseline = runs[baseline_key][0]
            if baseline.get("estimatedCostUsd") is None or run.get("estimatedCostUsd") is None or not tokens(baseline) or not tokens(run):
                continue
            baseline_cost = baseline["estimatedCostUsd"]
            candidate_cost = run["estimatedCostUsd"]
            pairs.append({
                "id": case,
                "repetition": repetition,
                "baselineCostUsd": baseline_cost,
                "candidateCostUsd": candidate_cost,
                "savingFraction": 1 - candidate_cost / baseline_cost if baseline_cost else None,
                "baselineDurationMs": baseline["durationMs"],
                "candidateDurationMs": run["durationMs"],
                "baselineTokens": tokens(baseline),
                "candidateTokens": tokens(run),
                "shape": next((choice["choice"] for choice in run.get("routing", []) if choice["objective"] == "workflow"), None),
                "routes": [f"{stage['route'].get('model')}:{stage['route'].get('effort')}" for stage in run.get("stages", [])],
                "paceVexCalls": run.get("paceRoutingCalls", 0),
                "agentVexCalls": run.get("agentVexCalls", 0),
                "vexCostUsd": (run.get("vex") or {}).get("cost"),
            })
        baseline_total = sum(pair["baselineCostUsd"] for pair in pairs)
        candidate_total = sum(pair["candidateCostUsd"] for pair in pairs)
        token_fields = ("raw", "input", "cachedInput", "cacheWriteInput", "output", "reasoningOutput")
        case_outcomes = []
        for case in sorted({pair["id"] for pair in pairs}):
            group = [pair for pair in pairs if pair["id"] == case]
            baseline_case_cost = sum(pair["baselineCostUsd"] for pair in group)
            candidate_case_cost = sum(pair["candidateCostUsd"] for pair in group)
            case_outcomes.append({"id": case, "pairs": len(group),
                                  "costWins": sum(pair["candidateCostUsd"] < pair["baselineCostUsd"] for pair in group),
                                  "aggregateSavingFraction": 1 - candidate_case_cost / baseline_case_cost if baseline_case_cost else None})
        comparisons[arm] = {
            "qualityPassingPairs": len(pairs),
            "costWins": sum(pair["candidateCostUsd"] < pair["baselineCostUsd"] for pair in pairs),
            "costRegressions": [{"id": pair["id"], "repetition": pair["repetition"]} for pair in pairs if pair["candidateCostUsd"] >= pair["baselineCostUsd"]],
            "baselineCostUsd": baseline_total,
            "candidateCostUsd": candidate_total,
            "aggregateSavingFraction": 1 - candidate_total / baseline_total if baseline_total else None,
            "medianPairSavingFraction": median(pair["savingFraction"] for pair in pairs) if pairs else None,
            "baselineDurationMs": sum(pair["baselineDurationMs"] for pair in pairs),
            "candidateDurationMs": sum(pair["candidateDurationMs"] for pair in pairs),
            "baselineRawTokens": sum(pair["baselineTokens"]["raw"] for pair in pairs),
            "candidateRawTokens": sum(pair["candidateTokens"]["raw"] for pair in pairs),
            "baselineTokenTotals": {field: sum(pair["baselineTokens"][field] for pair in pairs) for field in token_fields},
            "candidateTokenTotals": {field: sum(pair["candidateTokens"][field] for pair in pairs) for field in token_fields},
            "shapes": dict(Counter(pair["shape"] for pair in pairs if pair["shape"])),
            "routes": dict(Counter(" + ".join(pair["routes"]) for pair in pairs)),
            "paceVexCalls": sum(pair["paceVexCalls"] for pair in pairs),
            "agentVexCalls": sum(pair["agentVexCalls"] for pair in pairs),
            "vexCostUsd": sum(pair["vexCostUsd"] or 0 for pair in pairs),
            "caseOutcomes": case_outcomes,
            "pairs": pairs,
        }
    report = {"armQuality": arm_quality, "comparisons": comparisons,
              "note": "Only pairs with manual pass grades, passing checks, complete usage, and costs are compared. Dollar amounts are estimated Standard API equivalents. Vex cost is separate."}
    path = root / "graded-summary.json"
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    for arm, item in comparisons.items():
        saved = item["aggregateSavingFraction"]
        print(f"{arm}: {item['qualityPassingPairs']} quality-passing pairs, {item['costWins']} cost wins, {saved:.1%} aggregate saving" if saved is not None else f"{arm}: no quality-passing pairs")
    print(f"Graded report: {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "report"])
    parser.add_argument("results", type=Path)
    args = parser.parse_args()
    root = args.results.resolve()
    runs = load_runs(root)
    if args.action == "prepare":
        prepare(root, runs)
    else:
        score(root, runs)


if __name__ == "__main__":
    main()
