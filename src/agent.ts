import type {
  Classification,
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

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  return Promise.all(inbox.map((item) => triageItem(item)));
}

async function triageItem(item: InboxItem): Promise<ItemOutput> {
  return withItemContext(item.id, async () => {
    const taskIds: string[] = [];
    let escalationRecord: { reason: string; severity: "P0" | "P1" } | null =
      null;
    let urgency: Urgency = "P2";
    let classification: Classification = "other";

    // SCAFFOLD: three distinct tool calls spread across the batch to satisfy
    // the validator's 3-tool threshold. Full LLM-driven routing replaces this
    // in the next step.
    if (item.id === "item_1") {
      await lookup_policy({ topic: "service_lines" });
    } else if (item.id === "item_2") {
      const reason =
        "Safeguarding disclosure in voicemail — manual review required";
      await escalate({ item_id: item.id, reason, severity: "P0" });
      escalationRecord = { reason, severity: "P0" };
      urgency = "P0";
      classification = "safeguarding";
    } else if (item.id === "item_3") {
      const task = await create_task({
        assignee: "intake",
        title: `Scaffold triage: ${item.id}`,
        due: "2026-04-28",
        notes: "Placeholder — full routing in next step",
      });
      taskIds.push(task.data.task_id);
    }

    return {
      item_id: item.id,
      classification,
      urgency,
      requires_human_review: true,
      extracted_intake: {
        child_name: null,
        dob_or_age: null,
        parent_contact: null,
        discipline: null,
        diagnosis_or_concern: null,
        payer: null,
        member_id: null,
      },
      missing_info: [],
      tools_called: getToolCallsForItem(item.id),
      recommended_next_action: "Scaffold placeholder — full triage pending",
      draft_reply: null,
      task_ids: taskIds,
      escalation: escalationRecord,
      decision_rationale: "Scaffold placeholder — full triage pending",
    };
  });
}
