import { describe, it, expect } from "vitest";
import { extractLatestAdvisorResponse, getToolDefinitions, handleToolCall } from "../src/server.js";

describe("extractLatestAdvisorResponse", () => {
  it("extracts the last advisor reply after the final lead prompt", () => {
    const pane = `
@team-lead❯ first question

⏺ first answer from advisor

@team-lead❯ second question

⏺ second answer from advisor
    with multiple lines
    and some indentation
`;
    const result = extractLatestAdvisorResponse(pane);
    expect(result).toContain("second answer from advisor");
    expect(result).toContain("multiple lines");
    expect(result).not.toContain("first answer");
  });

  it("strips the leading ⏺ marker", () => {
    const pane = `@team-lead❯ ping\n\n⏺ acknowledged\n`;
    const result = extractLatestAdvisorResponse(pane);
    expect(result.startsWith("⏺")).toBe(false);
    expect(result).toContain("acknowledged");
  });

  it("returns full pane text when no lead prompt is present", () => {
    const pane = "just some random output without a prompt marker";
    const result = extractLatestAdvisorResponse(pane);
    expect(result).toContain("random output");
  });

  it("stops at the next advisor prompt marker", () => {
    const pane = `
@team-lead❯ question

⏺ answer line 1
answer line 2

@advisor❯ waiting
`;
    const result = extractLatestAdvisorResponse(pane);
    expect(result).toContain("answer line 1");
    expect(result).toContain("answer line 2");
    expect(result).not.toContain("waiting");
  });

  it("handles the real-world advisor pane format", () => {
    const pane = `
 ▐▛███▜▌   Claude Code v2.1.107
▝▜█████▛▘  Opus 4.6 with high effort · Claude Max
  ▘▘ ▝▝    /Users/grimm

@team-lead❯ Minimal ping — please reply with one word

⏺ acknowledged

──────────────────────────────────────────── @advisor ──
❯
`;
    const result = extractLatestAdvisorResponse(pane);
    expect(result).toBe("acknowledged");
  });
});

describe("workflow_scrape_advisor tool", () => {
  it("is listed among the tool definitions", () => {
    const tools = getToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain("workflow_scrape_advisor");
  });

  it("errors gracefully when no pane ID and no team name is available", async () => {
    const result = await handleToolCall("workflow_scrape_advisor", {});
    const text = result.content[0].text;
    expect(text).toContain("Error");
  });
});
