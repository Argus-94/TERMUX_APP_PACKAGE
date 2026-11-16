import { probeManusCredential, securedProviderFetch } from "../core/enhancements/auth/productionProviderTransport";
import { buildManusBalanceDiagnostic, type BalanceOutcome } from "./manus-balance-diagnostic";
import { persistentLogger } from "./persistent-logger";

const BASE_URL = "https://api.manus.ai";
const HTTP_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 6 * 60_000;
const POLL_MS = 1_500;
const MAX_OUTPUT = 100_000;
const MAX_PROMPT_CHARS = 20_000;
export type ManusProfile = "standard" | "lite" | "max" | "max-medium" | "max-high" | "max-extra" | "max-ultra";
export interface ManusTaskState {
  taskId: string; taskUrl?: string; lastEventId?: string; pending?: boolean;
  waiting?: boolean; submissionUnknown?: boolean; collectedOutput?: string; stopped?: boolean;
}
type Json = Record<string, any>;
const route = { baseUrl: BASE_URL };
function safeError(code = "request_failed"): Error {
  const messages: Record<string, string> = {
    unauthorized: "MANUS_UNAUTHORIZED: Manus authentication failed. Check the saved API key.",
    forbidden: "MANUS_FORBIDDEN: Manus denied this request.", not_found: "MANUS_NOT_FOUND: The Manus task or endpoint was not found.",
    rate_limited: "MANUS_RATE_LIMITED: Manus rate limit reached. Try again later.", request_failed: "MANUS_REQUEST_FAILED: Manus request failed. Please try again.",
    invalid_response: "MANUS_INVALID_RESPONSE: Manus returned an unexpected response.", remote_error: "MANUS_REMOTE_ERROR: The Manus task encountered an error.",
    timeout: "MANUS_TIMEOUT: Stopped waiting locally; the Manus task may still be running. Resume to continue polling.",
    unknown: "MANUS_SUBMISSION_UNKNOWN: The request may have reached Manus, but no task ID was received. Check cloud task history; do not retry automatically.",
  };
  return new Error(messages[code] ?? messages.request_failed);
}
function throwStatus(status: number): never {
  if (status === 401) throw safeError("unauthorized"); if (status === 403) throw safeError("forbidden");
  if (status === 404) throw safeError("not_found"); if (status === 429) throw safeError("rate_limited");
  if (status === 400 || status === 422) throw new Error("MANUS_INVALID_ARGUMENT: Request was rejected. Shorten or correct the prompt."); throw safeError();
}
async function request(path: string, method: string, body?: unknown, parentSignal?: AbortSignal, balanceDiagnostic = false): Promise<Json> {
  if (parentSignal?.aborted) throw safeError("timeout");
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, HTTP_TIMEOUT_MS);
  let diagnosticStatus: number | null = null;
  let diagnosticJson: 'not_attempted' | 'success' | 'failed' = 'not_attempted';
  let diagnosticValue: unknown;
  let diagnosticOutcome: BalanceOutcome = 'transport_failed';
  try {
    const response = await securedProviderFetch("manus", route, path, {
      method, headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
    });
    if (balanceDiagnostic) diagnosticStatus = response.status;
    if (balanceDiagnostic && !response.ok) diagnosticOutcome = 'http_rejected';
    if (!response.ok) throwStatus(response.status);
    try {
      const value = await response.json() as Json;
      if (balanceDiagnostic) { diagnosticJson = 'success'; diagnosticValue = value; diagnosticOutcome = 'accepted'; }
      return value;
    } catch {
      if (balanceDiagnostic) { diagnosticJson = 'failed'; diagnosticOutcome = 'json_failed'; }
      throw safeError(controller.signal.aborted ? "timeout" : "invalid_response");
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("MANUS_")) throw e;
    if (parentSignal?.aborted || controller.signal.aborted) throw safeError("timeout");
    throw safeError();
  } finally {
    clearTimeout(timer); parentSignal?.removeEventListener("abort", abort);
    if (balanceDiagnostic) {
      // Never pass a response, exception, URL, credential or request identifier to the logger.
      try {
        persistentLogger.add("info", "BalanceDiagnostic", buildManusBalanceDiagnostic(diagnosticStatus, diagnosticJson, diagnosticValue,
          parentSignal?.aborted || controller.signal.aborted ? 'aborted' : diagnosticOutcome));
      } catch { /* Diagnostics must never affect the balance request. */ }
    }
  }
}
export async function validateManusAccount(draft?: string, signal?: AbortSignal): Promise<{ userId: string; name?: string }> {
  let value: Json;
  if (draft !== undefined) {
    let response: Response;
    try { response = await probeManusCredential(draft, signal); }
    catch { if (signal?.aborted) throw safeError("timeout"); throw safeError(); }
    if (!response.ok) throwStatus(response.status);
    try { value = await response.json() as Json; } catch { throw safeError("invalid_response"); }
  } else value = await request("v2/user.me", "GET", undefined, signal);
  if (value.ok !== true || typeof value.user_id !== "string") throw safeError("invalid_response");
  return { userId: value.user_id, ...(typeof value.name === "string" ? { name: value.name } : {}) };
}
/** Read-only balance; callers must gate this on a verified saved credential. */
export async function getManusAvailableCredits(signal?: AbortSignal): Promise<unknown> {
  return request("v2/usage.availableCredits", "GET", undefined, signal, true);
}
function eventText(m: any): string {
  const pieces: string[] = [];
  if (m?.type === "assistant_message" && typeof m.assistant_message?.content === "string") pieces.push(m.assistant_message.content);
  if (m?.type === "error_message" && typeof m.error_message?.content === "string") pieces.push(m.error_message.content);
  if (m?.type === "assistant_message" && Array.isArray(m.assistant_message?.attachments)) for (const a of m.assistant_message.attachments)
    if (typeof a?.url === "string") pieces.push(`${typeof a.filename === "string" ? a.filename + ": " : ""}${a.url}`);
  return pieces.join("\n");
}
export async function runManusTask(opts: { prompt: string; profile: ManusProfile; previous?: ManusTaskState; signal?: AbortSignal; onState: (s: ManusTaskState) => Promise<void> }): Promise<string> {
  const { prompt, profile, signal, onState } = opts;
  if (!prompt.trim()) throw new Error("MANUS_INVALID_PROMPT: A prompt is required.");
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error("MANUS_PROMPT_TOO_LONG: Prompt exceeds the safe size limit.");
  if (signal?.aborted) throw safeError("timeout");
  // A definitively rejected POST (e.g. HTTP 401/429) has no remote task and
  // may be submitted again on a later explicit user attempt, never automatically.
  const previous = opts.previous && (opts.previous.taskId || opts.previous.submissionUnknown) ? opts.previous : undefined;
  let state: ManusTaskState = previous ? { ...previous } : { taskId: "", pending: true, submissionUnknown: true };
  if (previous?.submissionUnknown && !previous.taskId) throw safeError("unknown");
  if (previous?.taskId && previous.submissionUnknown) state = { ...previous, submissionUnknown: false, pending: true };
  let cursor: string | undefined;
  let initialStartEvent = state.lastEventId;
  let collecting = previous?.collectedOutput ?? "";
  let seen = new Set<string>();
  const persist = async () => onState({ ...state, collectedOutput: collecting.slice(-MAX_OUTPUT) });
  if (!previous) {
    await persist();
    try {
      const created = await request("v2/task.create", "POST", { message: { content: prompt }, agent_profile: profile, interactive_mode: true, share_visibility: "private" }, signal);
      if (created.ok !== true || typeof created.task_id !== "string") throw safeError("invalid_response");
      state = { taskId: created.task_id, ...(typeof created.task_url === "string" ? { taskUrl: created.task_url } : {}), pending: true };
      await persist();
    } catch (e) {
      if (!state.taskId) {
        const rejected = e instanceof Error && /^MANUS_(UNAUTHORIZED|FORBIDDEN|NOT_FOUND|RATE_LIMITED|INVALID_ARGUMENT):/.test(e.message);
        state = { ...state, pending: !rejected, submissionUnknown: !rejected };
        await persist();
      }
      throw e;
    }
  } else if (previous.pending || previous.submissionUnknown) {
    // Resume polling only: prompt is deliberately not sent.
    state.pending = true;
  } else {
    if (!state.taskId) throw new Error("MANUS_INVALID_STATE: A Manus task ID is required.");
    // If a stored task predates event checkpoints, establish the latest boundary
    // before sending; an earlier stopped event must not complete this new turn.
    if (!state.lastEventId) {
      const boundary = await request(`v2/task.listMessages?task_id=${encodeURIComponent(state.taskId)}&order=desc&limit=1`, "GET", undefined, signal);
      if (!Array.isArray(boundary.messages)) throw safeError("invalid_response");
      const id = boundary.messages[0]?.id;
      if (typeof id === "string") state.lastEventId = id;
    }
    // Persist ambiguity guard before the single non-retried follow-up POST.
    state = { ...state, pending: true, submissionUnknown: true, waiting: false, stopped: false };
    await persist();
    try {
      const sent = await request("v2/task.sendMessage", "POST", { task_id: state.taskId, message: { content: prompt }, agent_profile: profile }, signal);
      if (sent.ok !== true) throw safeError("invalid_response");
      state.submissionUnknown = false;
    } catch (e) {
      // The same task ID is known; polling may resume, but never issue the message again.
      state.submissionUnknown = false;
      await persist(); throw e;
    }
    // Use the prior event as an inclusive boundary; polling discards that event itself.
    initialStartEvent = state.lastEventId; collecting = ""; state.collectedOutput = "";
    await persist();
  }
  const started = Date.now();
  let sawStopped = Boolean(state.stopped);
  let waitingEvent: any;
  while (Date.now() - started < TOTAL_TIMEOUT_MS) {
    if (signal?.aborted) { state.pending = true; await persist(); throw safeError("timeout"); }
    const query = new URLSearchParams({ task_id: state.taskId, order: "asc", limit: "200" });
    if (initialStartEvent) query.set("start_event_id", initialStartEvent); else if (cursor) query.set("cursor", cursor);
    const page = await request(`v2/task.listMessages?${query}`, "GET", undefined, signal);
    if (!Array.isArray(page.messages)) throw safeError("invalid_response");
    for (const m of page.messages) {
      if (!m || typeof m !== "object") continue;
      const id = typeof m.id === "string" ? m.id : undefined;
      // start_event_id is inclusive; ignore marker and any duplicate IDs.
      if (id && (id === initialStartEvent || seen.has(id))) continue;
      if (id) { seen.add(id); state.lastEventId = id; }
      const text = m.type === "error_message" ? "" : eventText(m);
      if (text) collecting = ((collecting ? collecting + "\n" : "") + text).slice(-MAX_OUTPUT);
      if (m.type === "assistant_message" && Array.isArray(m.assistant_message?.question_expectation?.options)) {
        const options = m.assistant_message.question_expectation.options.filter((x: unknown) => typeof x === "string");
        if (options.length) collecting = (collecting + "\n" + options.join(" / ")).slice(-MAX_OUTPUT);
      }
      const status = m.type === "status_update" ? m.status_update?.agent_status : undefined;
      if (status === "stopped") { sawStopped = true; waitingEvent = undefined; }
      if (status === "running") { sawStopped = false; waitingEvent = undefined; }
      if (status === "waiting") { sawStopped = false; waitingEvent = m; }
      if (status === "error" || m.type === "error_message") { state.pending = false; await persist(); throw safeError("remote_error"); }
    }
    if (typeof page.next_cursor === "string") cursor = page.next_cursor;
    initialStartEvent = undefined;
    state.stopped = sawStopped;
    await persist();
    // Drain the snapshot before interpreting status; older waiting/stopped
    // events on a prior page must not override a later running event.
    if (page.has_more === true) {
      if (!cursor) throw safeError("invalid_response");
      continue;
    }
    if (waitingEvent) {
      const d = waitingEvent.status_update?.status_detail;
      const explanation = [d?.waiting_description, d?.waiting_for_event_type].filter((x) => typeof x === "string" && x).join(" ");
      state.pending = false; state.waiting = true; await persist();
      return `${collecting ? collecting + "\n\n" : ""}${explanation ? explanation + "\n" : ""}Manus is waiting for your decision. Review the task at ${state.taskUrl ?? `https://manus.im/app/${state.taskId}`}. No action was confirmed. ${["messageAskUser", "cascadeAskUser"].includes(d?.waiting_for_event_type) ? "Answer this question with your next message." : "A normal follow-up message skips the pending action; respond only if that is intended."}`;
    }
    const detail = await request(`v2/task.detail?task_id=${encodeURIComponent(state.taskId)}`, "GET", undefined, signal);
    if (detail.ok !== true) throw safeError("invalid_response");
    // The v2 RPC wraps metadata in `task`, not in the response envelope.
    // Keep the event boundary as well: a detail snapshot alone must not finish
    // a new turn before its result/stopped events have been drained.
    const task = detail.task;
    if (!task || typeof task !== "object" || Array.isArray(task) ||
        !["running", "stopped", "waiting", "error", "deleted"].includes(task.status) ||
        (task.has_running_background_jobs !== undefined && typeof task.has_running_background_jobs !== "boolean")) throw safeError("invalid_response");
    if (task.status === "error" || task.status === "deleted") {
      state.pending = false; await persist(); throw safeError(task.status === "deleted" ? "not_found" : "remote_error");
    }
    // A newer running snapshot invalidates a previously observed stopped event.
    if (task.status === "running") { sawStopped = false; state.stopped = false; await persist(); }
    if (sawStopped && task.status === "stopped" && task.has_running_background_jobs === false) {
      state.pending = false; state.waiting = false; await persist();
      return `${previous?.pending ? "Resumed existing Manus task (the supplied prompt was not sent).\n" : ""}${collecting || "Manus task completed."}`;
    }
    cursor = undefined;
    initialStartEvent = state.lastEventId;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const timer = setTimeout(() => { cleanup(); resolve(); }, POLL_MS);
      const abort = () => { clearTimeout(timer); cleanup(); reject(safeError("timeout")); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    }).catch(async () => { state.pending = true; await persist(); throw safeError("timeout"); });
  }
  state.pending = true; await persist(); throw safeError("timeout");
}
