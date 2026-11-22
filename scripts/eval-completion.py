#!/usr/bin/env python3
"""Bounded live replay of message-only session decisions. No prompts in output.

Run through heavy-job.py --wait. Credentials stay in memory. No raw history is
saved: optional local cases must be explicitly labeled before evaluation.
"""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import statistics
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--models", default="typesafe/jev-1.14,openai/gpt-6-luna-decisions,perplexity/pplx-decider-flash-v1.3:free")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    # Use the production questions verbatim, not an eval-only prompt.
    questions = json.loads((Path(__file__).resolve().parents[1] / "src/completion-questions.json").read_text())
    keyfile = Path.home() / ".config/agentview/openrouter-api-key"
    key = keyfile.read_text().strip() if keyfile.exists() else os.environ["OPENROUTER_API_KEY"]
    cases = json.loads(args.cases.read_text())

    def run(model, case):
        request = {"model": model, "state": {"messages": case["messages"],
            "automatic_followup_pending": case.get("held", False)}, "questions": questions}
        started = time.monotonic()
        try:
            req = urllib.request.Request("https://openrouter.ai/api/alpha/decisions",
                data=json.dumps(request).encode(), headers={"Authorization": f"Bearer {key}",
                "Content-Type": "application/json", "X-Title": "AgentView completion replay"})
            with urllib.request.urlopen(req, timeout=25) as response:
                result = json.load(response)
            attention = result["answers"]["attention"]["choice"]
            choice = "needs_input" if attention == "needs_input" else result["answers"]["completion"]["choice"]
            return {"case": case["id"], "expected": case["expected"], "actual": choice,
                "ms": round((time.monotonic() - started) * 1000), "usage": result.get("usage", {})}
        except (urllib.error.URLError, KeyError, ValueError) as e:
            return {"case": case["id"], "expected": case["expected"], "error": type(e).__name__ + ": " + str(e),
                "ms": round((time.monotonic() - started) * 1000)}

    reports = []
    for model in args.models.split(","):
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            rows = list(pool.map(lambda case: run(model, case), cases))
        report = {"model": model, "cases": len(rows),
            "correct": sum(r.get("actual") == r["expected"] for r in rows),
            "false_project_done": sum(r.get("actual") == "project_done" and r["expected"] != "project_done" for r in rows),
            "median_ms": statistics.median(r["ms"] for r in rows),
            "total_cost": sum(r.get("usage", {}).get("cost", 0) for r in rows),
            "upstream_cost": sum(r.get("usage", {}).get("cost_details", {}).get("upstream_inference_cost", 0) for r in rows),
            "mean_input_tokens": round(statistics.mean(r.get("usage", {}).get("input_tokens", 0) for r in rows)),
            "results": rows}
        reports.append(report)
        print(json.dumps({k: v for k, v in report.items() if k != "results"}), flush=True)
    if args.output:
        args.output.write_text(json.dumps(reports, indent=2) + "\n")


if __name__ == "__main__":
    main()
