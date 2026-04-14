import type { DetectionResult, ExecutionMode } from "./types.js";

const TEAMS_ENV_VAR = "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS";
const TMUX_ENV_VAR = "TMUX";

export function detectExecutionMode(
  env: Record<string, string | undefined> = process.env,
): DetectionResult {
  const teamsEnvVar = env[TEAMS_ENV_VAR] === "1";
  const insideTmux = Boolean(env[TMUX_ENV_VAR]);

  let mode: ExecutionMode;
  let reason: string;

  if (teamsEnvVar && insideTmux) {
    mode = "teams";
    reason = `${TEAMS_ENV_VAR}=1 and running inside tmux — Teams mode active. Will attempt TeamCreate; falls back to Agent if unavailable.`;
  } else if (teamsEnvVar && !insideTmux) {
    mode = "agent";
    reason = `${TEAMS_ENV_VAR}=1 but not inside tmux — using Agent fallback. Teams mode requires tmux for separate panes.`;
  } else {
    mode = "agent";
    reason = `${TEAMS_ENV_VAR} not set — using Agent fallback mode.`;
  }

  return { mode, teamsEnvVar, insideTmux, reason };
}

export function downgradeToAgent(current: DetectionResult): DetectionResult {
  return {
    ...current,
    mode: "agent",
    reason: `Downgraded from Teams to Agent: TeamCreate call failed. ${current.reason}`,
  };
}
