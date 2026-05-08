import type { Frame, FrameReason } from "../../src/types";
import { layout, type Layout } from "./layout";
import type { AgentDecision, AgentEvent } from "./agent";

const DEFAULT_HISTORY_CAPACITY = 200;
const SUMMARY_LEN = 60;

export interface NethackPane {
  readonly pid: number;
  readonly bellsCumulative: number;
  readonly title: string;
}

export interface TurnState {
  readonly number: number;
  readonly frameReason: FrameReason;
  readonly streamingText: string;
  readonly committed: AgentDecision | null;
}

// One entry in the tool-history pane (left-bottom in tri mode). Mirrors
// what was previously called TurnRecord — kept under the same shape so
// renderers and tests don't churn — but the *list* is now ordered
// newest-at-end, not newest-at-start.
export interface ToolRecord {
  readonly number: number;
  readonly frameReason: FrameReason;
  readonly summary: string;
  readonly decision: AgentDecision | "error";
}

// One entry in the chat pane (right column in tri mode). Carries the
// model's free-form text for that turn, separate from the tool-call shape.
export interface ChatRecord {
  readonly number: number;
  readonly text: string;
}

// Marker for a tool call that's started but hasn't completed yet. The
// renderer shows this as the visually-last row in the tool-history
// pane (dim, prefixed with `…`) so the user can see the call landed
// before the result arrives. Long-running tools (autopilot_explore
// with a large stepCap) used to leave the pane silent for 30+ seconds.
export interface PendingTool {
  readonly number: number;
  readonly name: string;
  readonly argsSummary: string;     // short "(stepCap:150)" form
  readonly progress: string;         // most recent reportProgress detail; "" if none
}

export type Status = "running" | "quitting" | "exited" | "tooSmall";

// What the conductor is doing right now. Drives the agent-pane title
// indicator. `since` is epoch ms; the renderer derives elapsed and
// flips display to "paused Xs" once elapsed crosses a threshold.
// `detail` is opaque text the renderer appends to the kind label.
export type ConductorStatusKind =
  | "idle"
  | "thinking"
  | "tool_running"
  | "reconnecting"
  | "error"
  | "exited";

export interface ConductorStatus {
  readonly kind: ConductorStatusKind;
  readonly since: number;          // epoch ms
  readonly detail: string;         // tool name, error code, etc. — may be ""
}

export interface ViewState {
  readonly layout: Layout;
  readonly status: Status;
  readonly nethack: NethackPane;
  readonly currentTurn: TurnState | null;
  readonly toolHistory: readonly ToolRecord[];   // oldest-first; newest-at-end
  readonly chatHistory: readonly ChatRecord[];   // oldest-first; newest-at-end
  readonly pendingTool: PendingTool | null;       // visible tool currently executing
  readonly historyCapacity: number;
  readonly agentLabel: string;                   // model id only
  readonly costLine: string;                     // most recent cost summary; "" before first turn
  readonly conductorStatus: ConductorStatus;
  readonly errorBanner: string | null;
}

export interface InitArgs {
  hostCols: number;
  hostRows: number;
  agentLabel: string;
  pid: number;
  historyCapacity?: number;
  now?: number; // epoch ms; tests inject
}

export function initialState(args: InitArgs): ViewState {
  const now = args.now ?? Date.now();
  return {
    layout: layout(args.hostCols, args.hostRows),
    status: "running",
    nethack: {
      pid: args.pid,
      bellsCumulative: 0,
      title: "",
    },
    currentTurn: null,
    toolHistory: [],
    chatHistory: [],
    pendingTool: null,
    historyCapacity: args.historyCapacity ?? DEFAULT_HISTORY_CAPACITY,
    agentLabel: args.agentLabel,
    costLine: "",
    conductorStatus: { kind: "idle", since: now, detail: "" },
    errorBanner: null,
  };
}

export function onToolPendingStart(state: ViewState, pending: PendingTool): ViewState {
  return { ...state, pendingTool: pending };
}

export function onToolPendingProgress(state: ViewState, progress: string): ViewState {
  if (state.pendingTool === null) return state;
  return { ...state, pendingTool: { ...state.pendingTool, progress } };
}

export function onToolPendingClear(state: ViewState): ViewState {
  if (state.pendingTool === null) return state;
  return { ...state, pendingTool: null };
}

export function onCostLine(state: ViewState, line: string): ViewState {
  return { ...state, costLine: line };
}

export function onChildFrame(state: ViewState, frame: Frame): ViewState {
  return {
    ...state,
    nethack: {
      ...state.nethack,
      bellsCumulative: state.nethack.bellsCumulative + frame.snapshot.bellsSinceLast,
      title: frame.snapshot.title || state.nethack.title,
    },
  };
}

export function onTurnStart(
  state: ViewState,
  args: { turn: number; frameReason: FrameReason },
): ViewState {
  return {
    ...state,
    currentTurn: {
      number: args.turn,
      frameReason: args.frameReason,
      streamingText: "",
      committed: null,
    },
  };
}

export function onAgentEvent(state: ViewState, event: AgentEvent): ViewState {
  if (state.currentTurn === null) return state;
  const turn = state.currentTurn;
  switch (event.kind) {
    case "thinking":
      return {
        ...state,
        currentTurn: { ...turn, streamingText: turn.streamingText + event.delta },
      };
    case "action":
      return { ...state, currentTurn: { ...turn, committed: event.move } };
    case "error":
      return {
        ...state,
        currentTurn: { ...turn, committed: null },
        errorBanner: `agent error: ${event.message}`,
      };
  }
}

export function onTurnEnd(state: ViewState): ViewState {
  if (state.currentTurn === null) return state;
  const turn = state.currentTurn;
  const decision: AgentDecision | "error" = turn.committed ?? "error";
  const fullText = turn.streamingText.replace(/\s+/g, " ").trim();
  const summary = fullText.slice(0, SUMMARY_LEN);

  // Tool record is keyed off the committed decision + summary line
  // (used in the tool-history pane).
  const tool: ToolRecord = {
    number: turn.number,
    frameReason: turn.frameReason,
    summary,
    decision,
  };
  // Chat record carries the full streaming text for that turn (the
  // chat pane wraps it across as many rows as needed). If the model
  // emitted no text, skip the chat entry — there's nothing to show.
  const nextToolHistory = pushBounded(state.toolHistory, tool, state.historyCapacity);
  const nextChatHistory =
    fullText.length > 0
      ? pushBounded(
          state.chatHistory,
          { number: turn.number, text: fullText },
          state.historyCapacity,
        )
      : state.chatHistory;

  return {
    ...state,
    toolHistory: nextToolHistory,
    chatHistory: nextChatHistory,
    // Clear currentTurn. The old code kept it sticky for the side/stacked
    // live-thinking pre-area, but that area no longer exists in any
    // layout. Holding it sticky causes a real bug: text deltas from the
    // NEXT assistant message arrive before that turn's onToolStart fires
    // (which is what calls onTurnStart and creates a fresh currentTurn).
    // If currentTurn is non-null, those deltas land on the COMPLETED
    // turn's streamingText (already flushed to chatHistory), not on the
    // pendingThinking buffer that onToolStart would later flush. Result:
    // every turn after the first ended up with empty streamingText and
    // no chat-history entry.
    currentTurn: null,
  };
}

export function onConductorStatus(
  state: ViewState,
  status: ConductorStatus,
): ViewState {
  return { ...state, conductorStatus: status };
}

export function onResize(state: ViewState, hostCols: number, hostRows: number): ViewState {
  return { ...state, layout: layout(hostCols, hostRows) };
}

export function onChildExited(
  state: ViewState,
  reason: "exited" | "crashed",
  exitCode?: number,
): ViewState {
  const code = exitCode === undefined ? "?" : String(exitCode);
  return {
    ...state,
    status: "exited",
    errorBanner: `child ${reason} (code=${code}) — press q to exit`,
  };
}

// Append `record` to `list`, dropping the oldest when over capacity.
// Returns a new array (lists in ViewState are readonly).
function pushBounded<T>(list: readonly T[], record: T, cap: number): readonly T[] {
  if (cap <= 0) return list;
  if (list.length < cap) return [...list, record];
  return [...list.slice(list.length - cap + 1), record];
}
