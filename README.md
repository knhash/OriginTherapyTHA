# Origin AI Engineering Take-Home: Referral Inbox Triage Agent

Origin builds software for pediatric therapy practices. In this assignment, you are helping a fictional practice, Cedar Kids Therapy, triage its Monday inbox.

## Scenario

It is Monday at 8am at a multi-disciplinary pediatric therapy practice supporting speech-language pathology, occupational therapy, and physical therapy. The shared inbox accumulated items over the weekend from pediatrician fax referrals, parent voicemails, parent portal messages, and emails. Build an AI agent prototype that turns the messy batch into a sorted, human-reviewable action plan.

## What We Expect

Strong submissions are usually incomplete but honest. We are evaluating triage judgment, tool orchestration, and scoping, not whether you finished every nice-to-have. Produce some output for every item, even thin; document what you cut in the README.

You may use any AI coding agent (Claude Code, Cursor, Codex, etc.) while building. State your stack and assumptions in your README.

Runtime LLM usage is allowed and recommended, but not required. Origin will provide a temporary capped API key for either OpenAI or Anthropic; the email distributing the key will name the provider and the environment variable to set (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`). You may also use your own provider. You may install dependencies for the provider you choose (e.g., `npm install openai` or `npm install @anthropic-ai/sdk`). Use any key only with the provided synthetic data, store it in an environment variable, and do not commit it. Model choice is not part of the rubric.

## How To Run

```bash
npm install
npm run triage   -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

The commands also work with no flags and default to the paths above. Reviewers may run the same commands against similar hidden synthetic input. Do not hardcode input, output, or trace paths.

## Share And Submit

Create your own GitHub repo from this starter pack and implement your solution there. The repo can be public or private. When you are done, submit the repo link. If it is private, grant access to the Origin reviewer GitHub account `@nixu`.

Commit your code, your updated `README.md`, and your final generated `output.json`. Do not commit API keys, `.env` files, real PHI, `node_modules/`, or `.trace/`.

We expect you to spend about 2 hours. If you stop before finishing, commit what you have and describe the cuts in your README.

Update this README with these sections before submitting:

1. How to run
2. Stack and runtime
3. Architecture
4. Failure modes and production eval
5. What I chose not to build, and why
6. What I would do with another 4 hours

## Your Task

Implement the agent in `src/agent.ts`. It should read the `InboxItem[]` it receives, use the provided tools where appropriate, and return one output item per inbox item. `src/index.ts` wraps your items with `buildBatchOutput()` and writes the final `output.json`.

Available tools: `search_patient`, `verify_insurance`, `lookup_policy`, `find_slots`, `hold_slot`, `create_task`, `draft_message`, `escalate`.

Use `schema/output.schema.json` as the source of truth for the output shape. `data/example_output.json` shows one non-trivial worked item. It is illustrative and is not expected to pass validation by itself. **Do not copy the example call IDs** into your output — real outputs must use the `call_id` values returned by `getToolCallsForItem()`.

## Time Box

Spend about 2 hours. Suggested allocation: 20 minutes reading and designing, 70 minutes building, 20 minutes self-evaluating against the validator and the inbox, 10 minutes updating the README. Expected end-to-end runtime for `npm run triage` should be a few minutes or less; if your agent is much slower, that is worth noting in the README rather than optimizing under time pressure.

Minimum viable submission: processes every item in `data/inbox.json`, makes relevant tool calls including at least 3 distinct tools across the batch, writes a valid `output.json`, and passes `npm run validate`. Beyond that floor, your architecture, error handling, audit discipline, and scoping choices are part of what we evaluate.

## Constraints

- Use TypeScript, Node LTS, and npm. If this creates a real accessibility or environment issue, reach out.
- Use the provided tools in `src/tools.ts`; do not modify, reimplement, or bypass them. The tools create the audit trace used by the validator, so bypassing them fails validation.
- Use at least 3 distinct tools across the batch. Strong solutions use tools as part of the decision process across multiple items, not just once to satisfy the threshold. Irrelevant or performative tool calls will be penalized.
- Use `withItemContext(item.id, async () => ...)` around item-level tool calls.
- Use `getToolCallsForItem(item.id)` for `tools_called[]`; pass the returned entries through unchanged.
- Use `buildBatchOutput(items)` through the starter `src/index.ts`; do not hand-compute summary counts.
- Do not auto-send messages. Use `draft_message` only.
- Do not schedule appointments. `find_slots` and `hold_slot` are reviewable; scheduling is not.
- Use only synthetic data. Do not add real PHI.

## Urgency Calibration

- `P0`: safeguarding, imminent harm, mandated-reporter escalation. Same-hour human review.
- `P1`: same-day operational issue requiring prompt staff action.
- `P2`: normal intake, scheduling, billing, or clinical-review workflow.
- `P3`: low-priority admin, FYI, spam.

Default to `P2` unless there is a clear safety or same-day operational reason. Over-escalation is itself a production failure mode.

## Review Variants

Similar synthetic variants may be run during review. We will not tell you what they cover, but the visible 8 items show the kinds of cases we care about.

## Rubric

- Safety and domain judgment: 25%
- Tool orchestration and action model: 25%
- Output correctness and auditability: 20%
- Engineering quality: 15%
- README and production thinking: 15%

Draft replies should be clear, empathetic, concise, and operationally useful. They must not provide clinical advice or imply messages were sent.

---

## 1. How to Run

```bash
npm install
cp .env.example .env          # add ANTHROPIC_API_KEY
npm run triage                # processes data/inbox.json → output.json + .trace/tool-calls.jsonl
npm run validate              # validates output.json against schema + trace
npm run typecheck             # TypeScript type check (no emit)
```

All paths default to `data/inbox.json`, `output.json`, and `.trace/tool-calls.jsonl`. Pass `--input`, `--output`, `--trace` flags to override. Do not commit `.env` or `.trace/`.

---

## 2. Stack and Runtime

- **Language:** TypeScript (Node 25, ESM modules, `"type": "module"`)
- **LLM:** Anthropic `claude-haiku-4-5-20251001` via `@anthropic-ai/sdk` — used for both parse and generate calls. Haiku was chosen deliberately: both tasks are token-light and structurally simple (structured JSON extraction and short reply drafting), and the JSON parse retry loop compensates for any marginal increase in malformed output risk vs. larger models. For a clinical inbox triage system processing potentially hundreds of items daily, Haiku's cost and latency profile is the right fit — Sonnet or Opus would add cost and latency with no meaningful quality gain on these specific tasks.
- **Runtime deps:** `tsx` (execution), `ulid` (stable tool call IDs), `ajv` + `ajv-formats` (output validation)
- **No database, no server** — pure batch processing; all state lives in memory for the duration of one `npm run triage` call
- **End-to-end runtime:** ~30–60 seconds for 8 items (parallel, IO-bound on LLM API latency)

---

## 3. Architecture

Two LLM calls per item, deterministic code orchestrating tool calls between them:

```
runAgent(inbox)
  └── Promise.all: triageItem(item) × 8           (parallel)
        └── withItemContext(item.id, async () => {
              1. claudeParse        → classification, urgency, flags, extracted_intake
              2. routeAndCallTools  → flag-driven tool branches, accumulates toolContext[]
              3. claudeGenerate     → draft_reply, recommended_next_action, decision_rationale
              4. draft_message      → final tool call (skipped on generate failure)
            })
```

**claudeParse (Haiku, ≤500 tokens out):** Receives raw item text; returns structured JSON with classification enum, urgency P0–P3, 7-field intake extraction, and 5 boolean flags. Up to 2 retries on JSON parse failure; on exhaustion, item falls back to a minimal valid output routed to manual intake.

**routeAndCallTools (deterministic):** Eight flag-driven branches, not item-ID-driven. P0 safeguarding wins over all other flags and returns early. Each branch appends `result_summary` strings to `toolContext[]`, which becomes context for the generate call. A catch-all ensures every item gets at least one tool call.

**claudeGenerate (Haiku, ≤600 tokens out):** Receives item body + parsed flags + toolContext; returns draft reply, recommended next action, and rationale. Hard prompt guardrails: no clinical advice, no implication of prior sends, neutral-only acknowledgement for safeguarding items, full Spanish output when `needs_spanish` is true. On failure, `draft_reply` is null (valid per schema) and static fallback strings are used.

**Audit trail:** Every tool call is recorded via AsyncLocalStorage + JSONL trace at `.trace/tool-calls.jsonl`. `getToolCallsForItem(item.id)` is passed through unchanged to `tools_called[]` — no hand-assembly.

---

## 4. Failure Modes and Production Eval

**LLM parse failure:** `claudeParse` returns `null` after all retries. Item is immediately escalated P1, a manual triage task is created for intake, and a minimal valid `ItemOutput` is returned with `requires_human_review: true`. Routing and generation are skipped entirely.

**LLM generate failure:** `claudeGenerate` returns `null`. `draft_reply` is null, `draft_message` is not called, and static fallback strings are used for `recommended_next_action` and `decision_rationale`. The item still passes schema validation.

**Swallowed errors in `catch {}`:** Both JSON `SyntaxError` and API/network errors currently receive the same treatment — retry, then null. In production these must be separated: network/auth errors warrant exponential backoff and alerting to on-call; JSON parse errors warrant prompt adjustment and logging of the raw response. This is a documented gap, not an oversight.

**LLM non-determinism:** Urgency calibration on borderline items (e.g., a complaint that could be P1 or P2) is not guaranteed stable across runs. The parse prompt includes an explicit over-escalation warning and concrete P0/P1 definitions to narrow variance, but a production system would run an eval harness (5+ runs per item, measure inter-run agreement) before treating outputs as ground truth.

**Over-escalation:** Treated as a first-class failure mode in the prompt: *"Over-escalation is itself a failure mode. Default to P2."*

---

## 5. What I Chose Not to Build, and Why

- **Appointment scheduling:** Hard constraint — `hold_slot` only. Holds are reviewable; scheduled appointments are not. Automated scheduling without human review is operationally unsafe for a clinical practice.
- **Auto-send:** Hard constraint — `draft_message` only. All outbound communication requires human sign-off, especially given HIPAA exposure.
- **Parallel tool calls within a single item:** Sequential is clearer for the audit trail, easier to debug, and sufficient for the batch size. Parallel tool calls would complicate `toolContext` ordering without measurable latency benefit here.
- **Retry on tool failures:** The provided tools are deterministic stubs that do not fail. Production would need retry + idempotency keys.
- **Confidence scores / multi-label output:** Haiku produces stable results for the 8 synthetic items. Adding probability outputs would require structured-output mode or post-processing and was not worth the complexity under time pressure.

---

## 6. What I Would Do with Another 4 Hours

- **Separate error types in `catch {}`:** Distinguish `SyntaxError` (JSON parse failure → prompt fix) from `APIError` / network errors (→ backoff + alerting). Log raw LLM output on parse failure for prompt debugging.
- **Eval harness:** Run the 8 items 5 times, compute per-item agreement rates on classification and urgency, surface disagreement cases before touching prompts. Non-determinism is invisible without this.
- **Local classifier bootstrapping:** Use LLM-generated classifications as a training signal with a multi-armed bandit (ε-greedy) controlling when the local model handles routing vs. falling back to the LLM. The LLM acts as the reward model for fine-tuning signals. End state: cheap local inference for routine `new_referral` / `scheduling` items; LLM reserved for edge cases and reward scoring. (See `IDEAS.md`.)
- **Schema-validated LLM output:** Use Anthropic's tool-use / structured output to eliminate the `JSON.parse(extractJson(...))` retry loop entirely — get type-safe outputs without the parse fragility.
- **Structured logging:** Replace removed `console.log` calls with a leveled logger (debug/info/warn/error) that includes `item_id`, per-call latency, token counts, and retry counts — essential for understanding production variance.
