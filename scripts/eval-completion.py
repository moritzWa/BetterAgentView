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
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args()
    # Use the production questions verbatim, not an eval-only prompt.
    questions = json.loads((Path(__file__).resolve().parents[1] / "src/completion-questions.json").read_text())
    keyfile = Path.home() / ".config/agentview/openrouter-api-key"
    key = keyfile.read_text().strip() if keyfile.exists() else os.environ["OPENROUTER_API_KEY"]
    cases = json.loads(args.cases.read_text())
    for case in cases:
        messages = case["messages"]
        if "exchanges" in messages:
            turns = messages["exchanges"]
            case["messages"] = {
                "context": {"initial_request": messages.get("initial_request", ""),
                    "previous_exchange": turns[-2] if len(turns) > 1 else None},
                "latest_exchange": turns[-1] if turns else None,
            }
        messages = case["messages"]
        def ordered(exchange):
            if exchange is None or isinstance(exchange, list):
                return exchange
            return [{"role": "user", "text": exchange["user"]},
                {"role": "assistant", "text": exchange["assistant_final"]}]
        messages["latest_exchange"] = ordered(messages.get("latest_exchange"))
        if "context" in messages:
            context = messages["context"]
            context["previous_exchange"] = ordered(context.get("previous_exchange"))
    cases = [dict(case, id=f"{case['id']}#{repeat + 1}")
        for repeat in range(args.repeat) for case in cases]

    def run(model, case):
        request = {"model": model, "state": {"messages": case["messages"],
            "automatic_followup_pending": case.get("held", False)}, "questions": questions}
        started = time.monotonic()
        def send(payload):
            req = urllib.request.Request("https://openrouter.ai/api/alpha/decisions",
                data=json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode(), headers={"Authorization": f"Bearer {key}",
                "Content-Type": "application/json", "X-Title": "AgentView completion replay"})
            with urllib.request.urlopen(req, timeout=20) as response:
                return json.load(response)
        def decision(result):
            attention = result["answers"]["attention"]["choice"]
            return "needs_input" if attention == "needs_input" else result["answers"]["completion"]["choice"]
        try:
            result = send(request)
            choice = decision(result)
            reviewed = choice == "unclear" and not case.get("held", False)
            usage = result.get("usage", {})
            if reviewed:
                try:
                    review = send({**request, "state": {"automatic_followup_pending": False,
                        "messages": {"latest_exchange": case["messages"]["latest_exchange"]}}})
                    if decision(review) in ("task_done", "project_done"):
                        choice = "task_done"  # A focused review never establishes project closure.
                    extra = review.get("usage", {})
                    usage = {"input_tokens": usage.get("input_tokens", 0) + extra.get("input_tokens", 0),
                        "cost": usage.get("cost", 0) + extra.get("cost", 0),
                        "cost_details": {"upstream_inference_cost":
                            usage.get("cost_details", {}).get("upstream_inference_cost", 0) +
                            extra.get("cost_details", {}).get("upstream_inference_cost", 0)}}
                except (urllib.error.URLError, KeyError, ValueError):
                    pass  # Same fail-closed behavior as production's bounded review.
            return {"case": case["id"], "expected": case["expected"], "actual": choice,
                "ms": round((time.monotonic() - started) * 1000), "usage": usage, "reviewed": reviewed}
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
            "focused_reviews": sum(r.get("reviewed", False) for r in rows),
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
