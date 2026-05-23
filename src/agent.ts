import Anthropic from "@anthropic-ai/sdk";
import type {
  Classification,
  ExtractedIntake,
  InboxItem,
  ItemOutput,
  Urgency,
} from "./types.js";
import {
  create_task,
  escalate,
  getToolCallsForItem,
  lookup_policy,
  withItemContext,
} from "./tools.js";

const anthropic = new Anthropic();

// ── Types ─────────────────────────────────────────────────────────────────────

interface ParseFlags {
  is_safeguarding: boolean;
  is_same_day_cancellation: boolean;
  needs_spanish: boolean;
  is_incomplete_referral: boolean;
  is_clinical_question: boolean;
}

interface ParseResult {
  classification: Classification;
  urgency: Urgency;
  extracted_intake: ExtractedIntake;
  missing_info: string[];
  flags: ParseFlags;
  reply_recipient: string;
  reply_channel: "email" | "phone" | "portal";
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const PARSE_SYSTEM = `You are a triage assistant for Cedar Kids Therapy, a pediatric therapy practice (SLP, OT, PT, ages 0-18).

Classify each inbox item and extract structured intake information.
Return ONLY a valid JSON object — no prose, no markdown, no explanation.

URGENCY:
- P0: safeguarding / imminent harm / mandated-reporter concern — same-hour human escalation
- P1: same-day operational issue requiring prompt staff action (e.g. same-day cancellation/reschedule)
- P2: normal intake, scheduling, billing, or clinical-review workflow — DEFAULT
- P3: low-priority admin, FYI, spam
Over-escalation is itself a failure mode. Default to P2.

CLASSIFICATIONS (pick exactly one):
new_referral | existing_patient_request | scheduling | clinical_question |
billing_question | missing_paperwork | provider_followup | complaint | safeguarding | spam | other

SAFEGUARDING RULE (highest priority):
Any mention of harm, abuse, neglect, rough handling, unsafe caregiving, or domestic concern
MUST produce: is_safeguarding=true, urgency=P0, classification=safeguarding.

INCOMPLETE REFERRAL: set is_incomplete_referral=true when a fax referral is missing two or more
of: child DOB, parent/guardian contact, insurance/member ID.

DISCIPLINE values: "SLP", "OT", "PT" only — return as an array or null.

REPLY CHANNEL: use "portal" if channel=portal_message, "phone" if channel=voicemail_transcript,
"email" if channel=email or fax_referral. Override to "phone" if body shows caller preference.

OUTPUT SCHEMA (JSON only):
{
  "classification": "<enum>",
  "urgency": "P0|P1|P2|P3",
  "extracted_intake": {
    "child_name": "<string|null>",
    "dob_or_age": "<string|null>",
    "parent_contact": "<string|null>",
    "discipline": ["SLP"|"OT"|"PT"] or null,
    "diagnosis_or_concern": "<string|null>",
    "payer": "<string|null>",
    "member_id": "<string|null>"
  },
  "missing_info": ["<missing field label>"],
  "flags": {
    "is_safeguarding": false,
    "is_same_day_cancellation": false,
    "needs_spanish": false,
    "is_incomplete_referral": false,
    "is_clinical_question": false
  },
  "reply_recipient": "<name or email of the person to reply to>",
  "reply_channel": "email|phone|portal"
}`;

function buildParseUserContent(item: InboxItem): string {
  return `Channel: ${item.channel}
Sender: ${item.sender}
Subject: ${item.subject}
Received: ${item.received_at}

Body:
${item.body}`;
}

// ── LLM helpers ───────────────────────────────────────────────────────────────

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return fenced ? fenced[1] : text.trim();
}

async function claudeParse(item: InboxItem): Promise<ParseResult | null> {
  const userContent = buildParseUserContent(item);
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const content =
      attempt === 0 ? userContent : `${userContent}\n\nReturn ONLY valid JSON.`;
    try {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: PARSE_SYSTEM,
        messages: [{ role: "user", content }],
      });

      const raw =
        response.content[0].type === "text" ? response.content[0].text : "";
      return JSON.parse(extractJson(raw)) as ParseResult;
    } catch {
      if (attempt === MAX_RETRIES) return null;
    }
  }

  return null;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  return Promise.all(inbox.map((item) => triageItem(item)));
}

async function triageItem(item: InboxItem): Promise<ItemOutput> {
  return withItemContext(item.id, async () => {
    const parsed = await claudeParse(item);

    // ── Parse failure fallback ──────────────────────────────────────────────
    if (!parsed) {
      const reason =
        "Automated parsing failed after retries — manual triage required";
      await escalate({ item_id: item.id, reason, severity: "P1" });
      const task = await create_task({
        assignee: "intake",
        title: `Manual triage: parsing failed for ${item.id}`,
        due: todayIso(),
        notes: item.body,
      });
      return {
        item_id: item.id,
        classification: "other",
        urgency: "P1",
        requires_human_review: true,
        extracted_intake: nullIntake(),
        missing_info: ["Automated parsing failed — manual review required"],
        tools_called: getToolCallsForItem(item.id),
        recommended_next_action:
          "Manual triage required — automated processing failed",
        draft_reply: null,
        task_ids: [task.data.task_id],
        escalation: { reason, severity: "P1" },
        decision_rationale:
          "LLM parse exhausted all retries; item routed to manual intake queue.",
      };
    }

    // ── Log parse result for review (Step 2 checkpoint) ────────────────────
    console.log(
      `[${item.id}] ${parsed.urgency} ${parsed.classification}`,
      JSON.stringify(parsed.flags),
    );

    const taskIds: string[] = [];
    let escalationRecord: { reason: string; severity: "P0" | "P1" } | null =
      null;

    // ── SCAFFOLD tool calls (3-tool threshold) — replaced in Step 3 ────────
    if (item.id === "item_1") {
      await lookup_policy({ topic: "service_lines" });
    } else if (item.id === "item_2") {
      const reason =
        "Safeguarding disclosure in voicemail — manual review required";
      await escalate({ item_id: item.id, reason, severity: "P0" });
      escalationRecord = { reason, severity: "P0" };
    } else if (item.id === "item_3") {
      const task = await create_task({
        assignee: "intake",
        title: `Scaffold triage: ${item.id}`,
        due: todayIso(),
        notes: "Placeholder — full routing in next step",
      });
      taskIds.push(task.data.task_id);
    }

    return {
      item_id: item.id,
      classification: parsed.classification,
      urgency: parsed.urgency,
      requires_human_review: true,
      extracted_intake: parsed.extracted_intake,
      missing_info: parsed.missing_info,
      tools_called: getToolCallsForItem(item.id),
      recommended_next_action: "Full triage routing pending (Step 3)",
      draft_reply: null,
      task_ids: taskIds,
      escalation: escalationRecord,
      decision_rationale: `Parsed by LLM: ${parsed.classification}, ${parsed.urgency}. Full routing pending.`,
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function nullIntake(): ExtractedIntake {
  return {
    child_name: null,
    dob_or_age: null,
    parent_contact: null,
    discipline: null,
    diagnosis_or_concern: null,
    payer: null,
    member_id: null,
  };
}
