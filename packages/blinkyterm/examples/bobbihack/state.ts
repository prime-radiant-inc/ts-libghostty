import type { Frame, FrameReason } from "../../src/types";
import { layout, type Layout } from "./layout";
import type { AgentDecision, AgentEvent } from "./agent";

const DEFAULT_HISTORY_CAPACITY = 200;
const SUMMARY_LEN = 60;

export interface NethackPane {
  readonly screenAnsi: string;
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

export interface TurnRecord {
  readonly number: number;
  readonly frameReason: FrameReason;
  readonly summary: string;
  readonly decision: AgentDecision | "error";
}

export type Status = "running" | "quitting" | "exited" | "tooSmall";

export interface ViewState {
  readonly layout: Layout;
  readonly status: Status;
  readonly nethack: NethackPane;
  readonly currentTurn: TurnState | null;
  readonly history: readonly TurnRecord[];
  readonly historyCapacity: number;
  readonly agentLabel: string;
  readonly errorBanner: string | null;
}

export interface InitArgs {
  hostCols: number;
  hostRows: number;
  agentLabel: string;
  pid: number;
  historyCapacity?: number;
}

export function initialState(args: InitArgs): ViewState {
  return {
    layout: layout(args.hostCols, args.hostRows),
    status: "running",
    nethack: {
      screenAnsi: "",
      pid: args.pid,
      bellsCumulative: 0,
      title: "",
    },
    currentTurn: null,
    history: [],
    historyCapacity: args.historyCapacity ?? DEFAULT_HISTORY_CAPACITY,
    agentLabel: args.agentLabel,
    errorBanner: null,
  };
}

export function onChildFrame(state: ViewState, frame: Frame): ViewState {
  return {
    ...state,
    nethack: {
      ...state.nethack,
      screenAnsi: frame.snapshot.toAnsi(),
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
  const summary = turn.streamingText.replace(/\s+/g, " ").trim().slice(0, SUMMARY_LEN);
  const record: TurnRecord = {
    number: turn.number,
    frameReason: turn.frameReason,
    summary,
    decision,
  };
  const next = [record, ...state.history].slice(0, state.historyCapacity);
  return { ...state, currentTurn: null, history: next };
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
