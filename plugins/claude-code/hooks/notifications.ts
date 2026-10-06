export type WorkflowNotice = {
  taskId: string;
  status: "completed" | "failed" | "killed";
  summary: string;
  result: string;
};
/** Parse only a single, structurally intact harness envelope; provenance is checked by the caller. */
export function workflowNotice(text: string): WorkflowNotice | undefined {
  const envelopes = text.match(
    /<task-notification>[\s\S]*?<\/task-notification>/g,
  );
  if (
    envelopes?.length !== 1 ||
    text.split("<task-notification>").length !== 2 ||
    text.split("</task-notification>").length !== 2
  )
    return;
  const body = envelopes[0]!;
  function field(name: string): string | undefined {
    const values = body.match(
      new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "g"),
    );
    if (values?.length !== 1) return;
    return values[0]!.slice(name.length + 2, -name.length - 3);
  }
  const taskId = field("task-id"),
    status = field("status"),
    summary = field("summary"),
    result = field("result");
  if (
    !taskId ||
    !/^[A-Za-z0-9_-]+$/.test(taskId) ||
    !status ||
    !["completed", "failed", "killed"].includes(status) ||
    summary === undefined
  )
    return;
  return {
    taskId,
    status: status as WorkflowNotice["status"],
    summary,
    result: result ?? "",
  };
}

export function workflowDelivery(
  e: import("claude-code").Frozen<import("claude-code").SessionAppendInput>,
): WorkflowNotice | undefined {
  if (
    e.agentId ||
    !["delivery", "prompt"].includes(e.door) ||
    e.origin.kind !== "task-notification"
  )
    return;
  const text = e.message.content
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? String(b.text) : ""))
    .join("\n");
  return workflowNotice(text);
}

export type TeammateFinished = { from: string; timestamp: string; result: string };
/** Live receive keeps the verified mailbox stamp; append reduces it to engine/note. */
export function teammateFinished(e: import("claude-code").Frozen<import("claude-code").SessionReceiveInput>): TeammateFinished | undefined {
  if (e.agentId || e.origin.kind !== "peer" || !("isVerified" in e.origin) || !e.origin.isVerified) return;
  let value: unknown;
  try { value = JSON.parse(e.text); } catch { return; }
  if (!value || typeof value !== "object") return;
  const r = value as Record<string, unknown>;
  if (r.type !== "idle_notification" || r.from !== e.origin.teammate ||
      typeof r.timestamp !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.timestamp) ||
      typeof r.result !== "string" || !r.result.trim()) return;
  return { from: e.origin.teammate, timestamp: r.timestamp, result: r.result.slice(0, 4000) };
}

const line = (text: string, limit: number) => text.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, limit);
const cap = (text: string, limit: number) => text.length > limit ? text.slice(0, Math.max(0, limit - 1)).trimEnd() + "…" : text;
/** Keep every top-level section visible within the shared report budget. */
export function workflowSummary(name: string, notice: WorkflowNotice): string {
  const heading = `Workflow ${line(name, 200) || "workflow"} — ${notice.status}`;
  const raw = notice.result.trim() || notice.summary.trim();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return cap(`${heading}\n\n${raw}`, 4000); }
  if (!value || typeof value !== "object")
    return cap(`${heading}\n\n${typeof value === "string" ? value.trim() : raw}`, 4000);
  const sections: [string, unknown][] = Array.isArray(value)
    ? value.map((item, i) => [item && typeof item === "object" && "name" in item ? String(item.name) : `Agent ${i + 1}`, item])
    : Object.entries(value);
  if (!sections.length) return cap(`${heading}\n\n${notice.summary.trim() || "No result."}`, 4000);
  const selected = sections.slice(0, 20);
  const budget = Math.floor((4000 - heading.length - 2 - selected.length * 2 - 60) / selected.length);
  const blocks = selected.map(([key, data]) => {
    const rows: string[] = [];
    function walk(item: unknown, path: string, depth: number) {
      if (rows.length >= 24) return;
      if (item === null || typeof item !== "object") {
        rows.push(`${path ? path + ": " : ""}${String(item ?? "No result").trim()}`);
      } else if (depth >= 6) rows.push(`${path}: Further nested results omitted.`);
      else if (Array.isArray(item)) {
        if (!item.length) rows.push(`${path}: None`);
        item.slice(0, 12).forEach((child, i) => walk(child, `${path} ${i + 1}`.trim(), depth + 1));
        if (item.length > 12) rows.push(`${path}: ${item.length - 12} more results omitted.`);
      } else {
        const entries = Object.entries(item);
        if (!entries.length) rows.push(`${path}: No result`);
        for (const [label, child] of entries.slice(0, 12)) walk(child, path ? `${path} / ${line(label, 80)}` : line(label, 80), depth + 1);
      }
    }
    walk(data, "", 0);
    return cap(`${line(key, 80)}:\n${rows.map(row => "- " + row).join("\n")}`, budget);
  });
  if (sections.length > selected.length) blocks.push(`${sections.length - selected.length} more sections omitted.`);
  return cap(`${heading}\n\n${blocks.join("\n\n")}`, 4000);
}
