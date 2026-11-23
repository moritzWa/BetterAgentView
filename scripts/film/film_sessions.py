"""Approved fictional company work and examples from Moritz's personal projects."""

PROJECTS = [
    "applied-evidence/research",
    "applied-evidence/platform",
    "applied-evidence/infra",
    "personal/cronus",
    "personal/clipglass",
    "personal/betteragentview",
]

# name, project index, state, summary. Keep 20 rows, six roots and five questions.
SESSIONS = [
    ("checkout-redesign", 1, "needs_input", "Should the coupon field stay on the cart page or move to checkout?"),
    ("rl-reward-debug", 0, "needs_input", "Reward rises but held-out accuracy is flat. Inspect the verifier?"),
    ("jev-to-qwen-distillation", 3, "working", "Distilling Jev letter probabilities into Qwen3.5-0.8B"),
    ("screenshot-ocr-search", 4, "working", "Indexing screenshot text with Apple Vision"),
    ("customer-onboarding", 1, "working", "Adding dataset upload validation and useful error messages"),
    ("wetlab-reasoning", 0, "working", "Building verifiable protocol-adaptation training tasks"),
    ("teacher-distillation", 0, "working", "Comparing soft teacher targets against sampled answers"),
    ("dataset-dedup", 0, "working", "Removing near-duplicate examples across train and eval splits"),
    ("eval-report", 0, "working", "Comparing the latest checkpoint with the base model"),
    ("training-resume", 0, "needs_input", "Resume the last checkpoint or rerun the interrupted epoch?"),
    ("usage-billing", 1, "working", "Fixing duplicate usage charges when requests are retried"),
    ("inference-latency", 2, "working", "Tracing slow requests after the latest deployment"),
    ("quantization-evals", 3, "working", "Measuring categorization accuracy after Q4_K_M quantization"),
    ("ocr-cpu-usage", 3, "working", "Skipping unchanged screen regions before OCR"),
    ("sleep-timeline-drag", 3, "working", "Fixing sleep entries that jump while dragging"),
    ("batch-paste-order", 4, "needs_input", "Keep selected clips in copy order when pasting?"),
    ("image-preview-zoom", 4, "working", "Preserving the cursor anchor during pinch-to-zoom"),
    ("session-switch-latency", 5, "needs_input", "Query is faster. Record another switching trace?"),
    ("chat-history-search", 5, "working", "Ranking matches by word proximity across past sessions"),
    ("launch-demo-video", 5, "working", "Updating the demo with real project examples"),
]


def populate(data, home):
    import copy

    roots = [home / "Code" / name for name in PROJECTS]
    for root in roots:
        root.mkdir(parents=True, exist_ok=True)
    seeds = {s["name"]: s for s in data["sessions"]}
    template = seeds["fix-flaky-tests"]
    providers = ["claude", "codex", "opencode", "cursor", "devin"]
    rows = []
    for i, (name, project, state, summary) in enumerate(SESSIONS):
        row = copy.deepcopy(seeds["checkout-redesign"] if i == 0 else template)
        provider = providers[i % len(providers)]
        if i:
            row.update(id=f"{provider}:host:film-{i}", provider=provider,
                       provider_session_id=f"synthetic-film-{i}", pid=None)
        row.update(name=name, cwd=str(roots[project]), state=state, summary=summary,
                   raw_state="waiting_on_user_input" if state == "needs_input" else "running")
        rows.append(row)
    data["sessions"] = rows
    return roots
