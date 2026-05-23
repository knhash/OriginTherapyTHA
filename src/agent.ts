import Anthropic, { APIError } from "@anthropic-ai/sdk";
import type {
  Classification,
  ExtractedIntake,
  InboxItem,
  ItemOutput,
  Urgency,
} from "./types.js";
import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  getToolCallsForItem,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
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

interface RoutingResult {
  taskIds: string[];
  escalationRecord: { reason: string; severity: "P0" | "P1" } | null;
  toolContext: string[];
}

interface GenerateResult {
  draft_reply: string;
  recommended_next_action: string;
  decision_rationale: string;
}

// ── Prompts ───────────────────────────────────────────────────────────────────

const PARSE_SYSTEM = `You are a triage assistant for Cedar Kids Therapy, a pediatric therapy practice (SLP, OT, PT, ages 0-18).

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
"email" if channel=email or fax_referral. Override to "phone" if body shows caller preference.`;

const GENERATE_SYSTEM = `You are a reply-drafting assistant for Cedar Kids Therapy, a pediatric therapy practice.
Draft a professional, empathetic outbound message and recommend the next staff action.

HARD RULES — any violation is a critical failure:
1. NO clinical advice, diagnoses, or treatment recommendations in the reply.
2. Do NOT imply that any message has been sent, appointment has been scheduled, or action has already been taken. The draft has not been reviewed or sent yet.
3. SAFEGUARDING: if is_safeguarding is true, draft ONLY a brief neutral acknowledgement ("Thank you for reaching out; a team member will follow up shortly"). Do NOT reference the concern, investigate, or provide any clinical or procedural framing. The item requires human review before any real communication.
4. If needs_spanish is true: write draft_reply entirely in Spanish.
5. Do not invent or add PHI not present in the original message.

TONE: Warm, professional, appropriate for families or referring providers.`;

const PARSE_TOOL: Anthropic.Messages.Tool = {
  name: "triage_parse",
  description:
    "Classify a Cedar Kids Therapy inbox item and extract structured intake data.",
  cache_control: { type: "ephemeral" },
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "classification",
      "urgency",
      "extracted_intake",
      "missing_info",
      "flags",
      "reply_recipient",
      "reply_channel",
    ],
    properties: {
      classification: {
        type: "string",
        enum: [
          "new_referral",
          "existing_patient_request",
          "scheduling",
          "clinical_question",
          "billing_question",
          "missing_paperwork",
          "provider_followup",
          "complaint",
          "safeguarding",
          "spam",
          "other",
        ],
      },
      urgency: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
      extracted_intake: {
        type: "object",
        additionalProperties: false,
        required: [
          "child_name",
          "dob_or_age",
          "parent_contact",
          "discipline",
          "diagnosis_or_concern",
          "payer",
          "member_id",
        ],
        properties: {
          child_name: { type: ["string", "null"] },
          dob_or_age: { type: ["string", "null"] },
          parent_contact: { type: ["string", "null"] },
          discipline: {
            oneOf: [
              { type: "null" },
              {
                type: "array",
                items: { type: "string", enum: ["SLP", "OT", "PT"] },
                minItems: 1,
              },
            ],
          },
          diagnosis_or_concern: { type: ["string", "null"] },
          payer: { type: ["string", "null"] },
          member_id: { type: ["string", "null"] },
        },
      },
      missing_info: { type: "array", items: { type: "string" } },
      flags: {
        type: "object",
        additionalProperties: false,
        required: [
          "is_safeguarding",
          "is_same_day_cancellation",
          "needs_spanish",
          "is_incomplete_referral",
          "is_clinical_question",
        ],
        properties: {
          is_safeguarding: { type: "boolean" },
          is_same_day_cancellation: { type: "boolean" },
          needs_spanish: { type: "boolean" },
          is_incomplete_referral: { type: "boolean" },
          is_clinical_question: { type: "boolean" },
        },
      },
      reply_recipient: { type: "string" },
      reply_channel: { type: "string", enum: ["email", "phone", "portal"] },
    },
  },
};

const GENERATE_TOOL: Anthropic.Messages.Tool = {
  name: "triage_generate",
  description:
    "Draft an outbound reply and recommend the next staff action for a Cedar Kids Therapy inbox item.",
  cache_control: { type: "ephemeral" },
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["draft_reply", "recommended_next_action", "decision_rationale"],
    properties: {
      draft_reply: {
        type: "string",
        description:
          "Outbound message body — plain text, no HTML. Write the actual message.",
      },
      recommended_next_action: {
        type: "string",
        description: "One sentence: what the reviewing staff member should do next.",
      },
      decision_rationale: {
        type: "string",
        description:
          "One to two sentences: why this routing and reply were chosen.",
      },
    },
  },
};

function buildGenerateUserContent(
  item: InboxItem,
  parsed: ParseResult,
  toolContext: string[],
): string {
  return `Original message:
Channel: ${item.channel}
Sender: ${item.sender}
Subject: ${item.subject}
Body: ${item.body}

Classification: ${parsed.classification} (${parsed.urgency})
Flags: ${JSON.stringify(parsed.flags)}
Reply to: ${parsed.reply_recipient} via ${parsed.reply_channel}

Routing context (what tools found):
${toolContext.length > 0 ? toolContext.join("\n") : "(no tool results)"}

Draft a reply and recommended next action following all hard rules.`;
}

function buildParseUserContent(item: InboxItem): string {
  return `Channel: ${item.channel}
Sender: ${item.sender}
Subject: ${item.subject}
Received: ${item.received_at}

Body:
${item.body}`;
}

// ── LLM helpers ───────────────────────────────────────────────────────────────

async function claudeParse(item: InboxItem): Promise<ParseResult | null> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: PARSE_SYSTEM,
      tools: [PARSE_TOOL],
      tool_choice: { type: "tool", name: "triage_parse" },
      messages: [{ role: "user", content: buildParseUserContent(item) }],
    });
    const block = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock =>
        b.type === "tool_use" && b.name === "triage_parse",
    );
    return block ? (block.input as ParseResult) : null;
  } catch (err) {
    if (err instanceof APIError) {
      console.error(`APIError claudeParse: ${err.status} ${err.message}`);
    }
    return null;
  }
}

async function claudeGenerate(
  item: InboxItem,
  parsed: ParseResult,
  toolContext: string[],
): Promise<GenerateResult | null> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: GENERATE_SYSTEM,
      tools: [GENERATE_TOOL],
      tool_choice: { type: "tool", name: "triage_generate" },
      messages: [{ role: "user", content: buildGenerateUserContent(item, parsed, toolContext) }],
    });
    const block = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock =>
        b.type === "tool_use" && b.name === "triage_generate",
    );
    return block ? (block.input as GenerateResult) : null;
  } catch (err) {
    if (err instanceof APIError) {
      console.error(`APIError claudeGenerate: ${err.status} ${err.message}`);
    }
    return null;
  }
}

// ── Deterministic tool routing ────────────────────────────────────────────────

async function routeAndCallTools(
  item: InboxItem,
  parsed: ParseResult,
): Promise<RoutingResult> {
  const taskIds: string[] = [];
  let escalationRecord: { reason: string; severity: "P0" | "P1" } | null =
    null;
  const toolContext: string[] = [];
  const { flags, extracted_intake: intake } = parsed;

  // ── P0 safeguarding — wins over all other flags ─────────────────────────
  if (flags.is_safeguarding) {
    const policy = await lookup_policy({ topic: "safeguarding" });
    toolContext.push(`Safeguarding policy: ${policy.data.snippets.join(" ")}`);

    const reason =
      "Safeguarding disclosure — potential harm to child; mandated-reporter escalation required";
    await escalate({ item_id: item.id, reason, severity: "P0" });
    toolContext.push(`Escalated P0: ${reason}`);
    escalationRecord = { reason, severity: "P0" };

    // Policy requires a same-hour clinical lead review task
    const task = await create_task({
      assignee: "clinical_lead",
      title: `SAFEGUARDING review: ${intake.child_name ?? item.id} — same-hour required`,
      due: todayIso(),
      notes: `Safeguarding disclosure received. Source: ${item.sender}. Body: ${item.body.slice(0, 300)}`,
    });
    taskIds.push(task.data.task_id);
    toolContext.push(task.result_summary);

    return { taskIds, escalationRecord, toolContext };
  }

  // ── P1 same-day cancellation ────────────────────────────────────────────
  if (flags.is_same_day_cancellation) {
    if (intake.child_name) {
      const pat = await search_patient({
        name: intake.child_name,
        dob: parseDob(intake.dob_or_age),
      });
      toolContext.push(
        `Patient lookup: ${pat.result_summary}` +
          (pat.data[0] ? ` — status: ${pat.data[0].status}` : ""),
      );
    }

    const policy = await lookup_policy({ topic: "cancellation" });
    toolContext.push(`Cancellation policy: ${policy.data.snippets.join(" ")}`);

    const reason =
      "Same-day cancellation — prompt staff action required to manage slot and contact family";
    await escalate({ item_id: item.id, reason, severity: "P1" });
    toolContext.push(`Escalated P1: ${reason}`);
    escalationRecord = { reason, severity: "P1" };

    const task = await create_task({
      assignee: "front_desk",
      title: `Same-day cancellation: ${intake.child_name ?? item.id}`,
      due: todayIso(),
      notes: `Contact family to reschedule. ${item.body.slice(0, 200)}`,
    });
    taskIds.push(task.data.task_id);
    toolContext.push(task.result_summary);

    return { taskIds, escalationRecord, toolContext };
  }

  // ── Clinical question ───────────────────────────────────────────────────
  if (flags.is_clinical_question) {
    const policy = await lookup_policy({ topic: "clinical_advice" });
    toolContext.push(
      `Clinical advice policy: ${policy.data.snippets.join(" ")}`,
    );

    return { taskIds, escalationRecord, toolContext };
  }

  // ── Incomplete referral ─────────────────────────────────────────────────
  if (flags.is_incomplete_referral) {
    const policy = await lookup_policy({ topic: "service_lines" });
    toolContext.push(`Service lines policy: ${policy.data.snippets.join(" ")}`);

    const task = await create_task({
      assignee: "intake",
      title: `Incomplete referral: ${intake.child_name ?? item.id} — missing info required`,
      due: nextBusinessDayIso(),
      notes: `Missing fields: ${parsed.missing_info.join(", ")}. Contact referring provider: ${item.sender}.`,
    });
    taskIds.push(task.data.task_id);
    toolContext.push(task.result_summary);

    return { taskIds, escalationRecord, toolContext };
  }

  // ── New referral / existing patient request ─────────────────────────────
  if (
    parsed.classification === "new_referral" ||
    parsed.classification === "existing_patient_request"
  ) {
    let patientRef: string = intake.child_name ?? item.id;

    if (intake.child_name) {
      const pat = await search_patient({
        name: intake.child_name,
        dob: parseDob(intake.dob_or_age),
      });
      toolContext.push(`Patient lookup: ${pat.result_summary}`);
      if (pat.data[0]) {
        patientRef = pat.data[0].patient_id;
        toolContext.push(
          `Existing patient found: ${pat.data[0].name}, status: ${pat.data[0].status}`,
        );
      }
    }

    // Language access policy before slot search so it informs routing
    if (flags.needs_spanish) {
      const policy = await lookup_policy({ topic: "language_access" });
      toolContext.push(
        `Language access policy: ${policy.data.snippets.join(" ")}`,
      );
    }

    if (!intake.payer) {
      // No insurance info — flag for intake follow-up
      const policy = await lookup_policy({ topic: "service_lines" });
      toolContext.push(`Service lines policy: ${policy.data.snippets.join(" ")}`);

      const task = await create_task({
        assignee: "intake",
        title: `Missing insurance info: ${intake.child_name ?? item.id}`,
        due: nextBusinessDayIso(),
        notes: "No payer information provided — contact family for insurance details before scheduling.",
      });
      taskIds.push(task.data.task_id);
      toolContext.push(task.result_summary);

      return { taskIds, escalationRecord, toolContext };
    }

    const ins = await verify_insurance({
      payer: intake.payer,
      member_id: intake.member_id ?? undefined,
    });
    toolContext.push(
      `Insurance: ${ins.result_summary}` +
        (ins.data.notes ? ` — ${ins.data.notes}` : "") +
        (ins.data.copay !== undefined ? `, copay $${ins.data.copay}` : "") +
        (ins.data.auth_required ? ", auth required" : ""),
    );

    if (
      ins.data.status === "out_of_network" ||
      ins.data.status === "expired" ||
      ins.data.status === "unknown"
    ) {
      const policy = await lookup_policy({ topic: "insurance" });
      toolContext.push(`Insurance policy: ${policy.data.snippets.join(" ")}`);

      const task = await create_task({
        assignee: "billing",
        title: `Insurance issue: ${intake.child_name ?? item.id} — ${ins.data.status}`,
        due: nextBusinessDayIso(),
        notes:
          ins.data.notes ??
          `Insurance status: ${ins.data.status}. Benefits conversation required before scheduling.`,
      });
      taskIds.push(task.data.task_id);
      toolContext.push(task.result_summary);
    } else {
      // in_network — find and hold a slot
      const discipline = intake.discipline?.[0];
      const slots = await find_slots({
        discipline,
        language: flags.needs_spanish ? "es" : undefined,
      });
      toolContext.push(`Slots: ${slots.result_summary}`);

      if (slots.data.length > 0) {
        const hold = await hold_slot({
          slot_id: slots.data[0].slot_id,
          patient_ref: patientRef,
        });
        toolContext.push(
          `Hold: ${hold.result_summary} — ${slots.data[0].provider_name}, ${slots.data[0].start}`,
        );
      } else {
        const task = await create_task({
          assignee: "intake",
          title: `No slots available: ${intake.child_name ?? item.id} — manual scheduling needed`,
          due: nextBusinessDayIso(),
          notes: `No ${discipline ?? "any"} slots found${flags.needs_spanish ? " (Spanish-speaking provider required)" : ""}. Manual scheduling required.`,
        });
        taskIds.push(task.data.task_id);
        toolContext.push(task.result_summary);
      }
    }
  }

  // ── Billing question ────────────────────────────────────────────────────
  if (parsed.classification === "billing_question") {
    const policy = await lookup_policy({ topic: "insurance" });
    toolContext.push(`Insurance policy: ${policy.data.snippets.join(" ")}`);
    const task = await create_task({
      assignee: "billing",
      title: `Billing question: ${intake.child_name ?? item.id}`,
      due: nextBusinessDayIso(),
      notes: `Billing inquiry from ${item.sender}. Body: ${item.body.slice(0, 300)}`,
    });
    taskIds.push(task.data.task_id);
    toolContext.push(task.result_summary);
    return { taskIds, escalationRecord, toolContext };
  }

  // ── Complaint ────────────────────────────────────────────────────────────
  if (parsed.classification === "complaint") {
    const policy = await lookup_policy({ topic: "service_lines" });
    toolContext.push(`Service lines policy: ${policy.data.snippets.join(" ")}`);
    if (parsed.urgency === "P1" || parsed.urgency === "P0") {
      const reason = `Urgent complaint from ${item.sender}`;
      await escalate({ item_id: item.id, reason, severity: "P1" });
      toolContext.push(`Escalated P1: ${reason}`);
      escalationRecord = { reason, severity: "P1" };
    }
    const task = await create_task({
      assignee: "front_desk",
      title: `Complaint: ${intake.child_name ?? item.id}`,
      due: nextBusinessDayIso(),
      notes: `From ${item.sender}. Body: ${item.body.slice(0, 300)}`,
    });
    taskIds.push(task.data.task_id);
    toolContext.push(task.result_summary);
    return { taskIds, escalationRecord, toolContext };
  }

  // ── Spam ─────────────────────────────────────────────────────────────────
  if (parsed.classification === "spam") {
    const task = await create_task({
      assignee: "front_desk",
      title: `Spam/no-action: ${item.id}`,
      due: nextBusinessDayIso(),
      notes: `Classified as spam. Logged for audit. Sender: ${item.sender}.`,
    });
    taskIds.push(task.data.task_id);
    toolContext.push(task.result_summary);
    return { taskIds, escalationRecord, toolContext };
  }

  // ── Missing paperwork ────────────────────────────────────────────────────
  if (parsed.classification === "missing_paperwork") {
    const policy = await lookup_policy({ topic: "service_lines" });
    toolContext.push(`Service lines policy: ${policy.data.snippets.join(" ")}`);
    const task = await create_task({
      assignee: "intake",
      title: `Missing paperwork: ${intake.child_name ?? item.id}`,
      due: nextBusinessDayIso(),
      notes: `Missing: ${parsed.missing_info.join(", ") || "unspecified"}. Contact: ${item.sender}. Body: ${item.body.slice(0, 200)}`,
    });
    taskIds.push(task.data.task_id);
    toolContext.push(task.result_summary);
    return { taskIds, escalationRecord, toolContext };
  }

  // ── Provider follow-up ───────────────────────────────────────────────────
  if (parsed.classification === "provider_followup") {
    if (intake.child_name) {
      const pat = await search_patient({
        name: intake.child_name,
        dob: parseDob(intake.dob_or_age),
      });
      toolContext.push(`Patient lookup: ${pat.result_summary}`);
    }
    const task = await create_task({
      assignee: "intake",
      title: `Provider follow-up: ${intake.child_name ?? item.id} — ${item.sender.slice(0, 60)}`,
      due: nextBusinessDayIso(),
      notes: `Provider follow-up from ${item.sender}. Body: ${item.body.slice(0, 300)}`,
    });
    taskIds.push(task.data.task_id);
    toolContext.push(task.result_summary);
    return { taskIds, escalationRecord, toolContext };
  }

  // ── Catch-all for unmatched classifications ─────────────────────────────
  // Handles: scheduling (non-same-day), other, and any future classification values.
  if (taskIds.length === 0 && toolContext.length === 0) {
    const task = await create_task({
      assignee: "intake",
      title: `Manual review: ${parsed.classification} — ${intake.child_name ?? item.id}`,
      due: nextBusinessDayIso(),
      notes: `Item did not match automated routing. Classification: ${parsed.classification}. Body: ${item.body.slice(0, 300)}`,
    });
    taskIds.push(task.data.task_id);
    toolContext.push(task.result_summary);
  }

  return { taskIds, escalationRecord, toolContext };
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
          "LLM parse returned null (APIError); item routed to manual intake queue.",
      };
    }

    const { taskIds, escalationRecord, toolContext } =
      await routeAndCallTools(item, parsed);

    const generateResult = await claudeGenerate(item, parsed, toolContext);

    if (generateResult) {
      await draft_message({
        recipient: parsed.reply_recipient,
        channel: parsed.reply_channel,
        body: generateResult.draft_reply,
        language: parsed.flags.needs_spanish ? "es" : "en",
      });
    }

    return {
      item_id: item.id,
      classification: parsed.classification,
      urgency: parsed.urgency,
      requires_human_review: true,
      extracted_intake: parsed.extracted_intake,
      missing_info: parsed.missing_info,
      tools_called: getToolCallsForItem(item.id),
      recommended_next_action:
        generateResult?.recommended_next_action ??
        "Manual review required — draft generation failed",
      draft_reply: generateResult?.draft_reply ?? null,
      task_ids: taskIds,
      escalation: escalationRecord,
      decision_rationale:
        generateResult?.decision_rationale ??
        `Routing complete. Context: ${toolContext.join(" | ")}`,
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function nextBusinessDayIso(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  while (date.getDay() === 0 || date.getDay() === 6) {
    date.setDate(date.getDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}

function parseDob(dobOrAge: string | null): string | undefined {
  if (!dobOrAge) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(dobOrAge) ? dobOrAge : undefined;
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
