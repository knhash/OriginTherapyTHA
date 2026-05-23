# Triage Agent Implementation Plan

## Architecture

Two focused LLM calls per item, deterministic code for tool orchestration between them.

```
runAgent(inbox)
  └── Promise.all: triageItem(item) × 8 (parallel)
        └── withItemContext(item.id, async () => {
              1. claudeParse(item)       → flags + intake + classification + urgency
              2. routeAndCallTools(...)  → deterministic tool calls based on flags + results
              3. claudeGenerate(...)     → draft_reply + rationale + next_action
              4. draft_message(body)     → final tool call
              5. buildItemOutput(...)    → getToolCallsForItem() + assemble schema
            })
```

## LLM Usage

**Claude call 1 — parse only** (`claude-haiku-4-5-20251001`, ~200 tokens out):
- Input: raw item text
- Output (JSON):
  ```json
  {
    "classification": "new_referral | safeguarding | scheduling | ...",
    "urgency": "P0 | P1 | P2 | P3",
    "extracted_intake": { "child_name", "dob_or_age", "parent_contact",
                          "discipline", "diagnosis_or_concern", "payer", "member_id" },
    "missing_info": [],
    "flags": {
      "is_safeguarding": false,
      "is_same_day_cancellation": false,
      "needs_spanish": false,
      "is_incomplete_referral": false,
      "is_clinical_question": false
    },
    "reply_recipient": "...",
    "reply_channel": "email | phone | portal"
  }
  ```
- Prompt includes: urgency rubric (P0–P3), classification enum, intake schema, policy guardrails
- Retry: up to 2 retries on JSON parse failure; each retry appends `"Return ONLY valid JSON."` to the prompt

**Claude call 2 — generate only** (~300 tokens out):
- Input: item body + tool results context (insurance status, slot info, policy snippets, patient found/not)
- Output (JSON): `{ draft_reply, recommended_next_action, decision_rationale }`
- Constraints in prompt: no clinical advice, no implication messages were sent, empathetic tone, Spanish if `needs_spanish`
- Retry: up to 2 retries on JSON parse failure

## LLM Parse Failure Fallback

If all retries on Claude call 1 are exhausted:
1. Call `escalate({ item_id, reason: "Automated parsing failed after retries — manual triage required", severity: "P1" })`
2. Call `create_task({ assignee: "intake", title: "Manual triage: parsing failed for [item_id]", due: today, notes: item.body })`
3. Return a minimal valid `ItemOutput`:
   - `classification: "other"`, `urgency: "P1"`
   - `extracted_intake`: all fields `null`
   - `missing_info: ["Automated parsing failed — manual review required"]`
   - `escalation: { reason: "...", severity: "P1" }`
   - `draft_reply: null`
   - `recommended_next_action`: `"Manual triage required — automated processing failed"`
   - `requires_human_review: true`

If Claude call 2 (generate) fails all retries: return `draft_reply: null`, use a static fallback rationale string. The item still passes validation since `draft_reply` is nullable.

## Deterministic Tool Routing

All inside `withItemContext(item.id, ...)`. Branches driven by flags + tool return values, not item IDs.

Throughout routing, accumulate a `toolContext: string[]` array by appending each tool's `result_summary` plus key data (e.g. insurance notes, patient status, slot count). This is joined and passed as context to Claude call 2.

```
is_safeguarding                                  [P0 wins over all other flags]
  → lookup_policy("safeguarding")
  → escalate(P0, reason)                         [save reason for escalation output field]

is_same_day_cancellation
  → search_patient(name, dob?)                   [dob optional — name match alone may work]
  → lookup_policy("cancellation")
  → escalate(P1, reason)
  → create_task(front_desk, due: today)

is_clinical_question
  → lookup_policy("clinical_advice")

is_incomplete_referral
  → lookup_policy("service_lines")
  → create_task(intake, due: next_business_day)

new_referral / existing_patient_request
  → search_patient(name, dob?)                   [if name available]
  → [if needs_spanish] lookup_policy("language_access")   [before slot search, informs routing]
  → verify_insurance(payer, member_id)           [if payer known]
      out_of_network / expired / unknown
        → lookup_policy("insurance")
        → create_task(billing, due: next_business_day)
      in_network
        → find_slots(discipline, language: "es" if needs_spanish)
        → if slots.length > 0:  hold_slot(slots[0], patient_ref)
          else:                  create_task(intake, "No slots found — manual scheduling needed")

[all paths where Claude call 2 succeeds]
  → draft_message(recipient, channel, body, language)    [body = draft_reply from call 2]

[fallback: parse failure or generate failure]
  → no draft_message call; draft_reply = null
```

## Output Assembly

After all tool calls:
- `tools_called` = `getToolCallsForItem(item.id)` — passed through unchanged
- `task_ids` = captured from each `create_task(...).data.task_id` as calls are made
- `escalation` = `{ reason, severity }` captured from the args passed to `escalate()` when called, else `null`
- `draft_reply` = body string passed to `draft_message()`; `null` if generate failed or fallback path
- `requires_human_review` = `true` (all items, always)

## Status

| Step | Description | Status |
|------|-------------|--------|
| 1 | Scaffold + SDK install, validator green | **Done** |
| 2 | Claude call 1 — parse/classify/flags | **Done** |
| 3 | Deterministic tool routing | **Done** |
| 4 | Claude call 2 — draft reply + rationale | Pending |
| 5 | Output assembly + full validate pass | Pending |
| 6 | Edge case hardening + README | Pending |

## Files Changed

| File | Change |
|------|--------|
| `package.json` | add `@anthropic-ai/sdk`, fix `fast-uri` vuln, tsx `--env-file` |
| `src/agent.ts` | `claudeParse` (Haiku, retry), `routeAndCallTools` (8 flag-driven branches + catch-all), parse-failure fallback, 7/8 tools wired |

## What Is Not Built

- No scheduling (by constraint — `hold_slot` only)
- No auto-send (by constraint — `draft_message` only)
- No parallel tool calls within a single item (sequential is clearer for audit trail)
- No retry on tool call failures (tools are deterministic stubs — they don't fail)
