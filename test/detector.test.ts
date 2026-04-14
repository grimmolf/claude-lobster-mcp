import { describe, it, expect } from "vitest";
import { detectExecutionMode, downgradeToAgent } from "../src/detector.js";

describe("detectExecutionMode", () => {
  it("returns teams mode when env var and tmux are set", () => {
    const result = detectExecutionMode({
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      TMUX: "/tmp/tmux-501/default,12345,0",
    });
    expect(result.mode).toBe("teams");
    expect(result.teamsEnvVar).toBe(true);
    expect(result.insideTmux).toBe(true);
  });

  it("returns agent fallback when env var is set but no tmux", () => {
    const result = detectExecutionMode({
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    });
    expect(result.mode).toBe("agent");
    expect(result.teamsEnvVar).toBe(true);
    expect(result.insideTmux).toBe(false);
  });

  it("returns agent fallback when env var is not set", () => {
    const result = detectExecutionMode({});
    expect(result.mode).toBe("agent");
    expect(result.teamsEnvVar).toBe(false);
  });

  it("returns agent fallback when env var is not '1'", () => {
    const result = detectExecutionMode({
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "true",
      TMUX: "/tmp/tmux",
    });
    expect(result.mode).toBe("agent");
  });
});

describe("downgradeToAgent", () => {
  it("changes mode to agent and updates reason", () => {
    const original = detectExecutionMode({
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      TMUX: "/tmp/tmux",
    });
    expect(original.mode).toBe("teams");

    const downgraded = downgradeToAgent(original);
    expect(downgraded.mode).toBe("agent");
    expect(downgraded.reason).toContain("Downgraded");
  });
});
