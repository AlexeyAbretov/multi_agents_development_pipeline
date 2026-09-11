export type CursorRunResult = {
  agentId: string | null;
  runId: string | null;
  status: "finished" | "error" | "startup_error";
  error: string | null;
  text: string | null;
};

export type CursorRunStarted = {
  agentId: string;
  runId: string;
};
