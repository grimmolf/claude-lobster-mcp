import { describe, it, expect } from "vitest";
import { loadWorkflow, parsePipelineCommand, resolveArgsTemplate, resolveStdin, resolveStepRef } from "../src/parser.js";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parsePipelineCommand", () => {
  it("parses llm.invoke with model and prompt", () => {
    const cmd = parsePipelineCommand('llm.invoke --model opus --prompt "Review this approach"');
    expect(cmd.name).toBe("llm.invoke");
    expect(cmd.args.model).toBe("opus");
    expect(cmd.args.prompt).toBe("Review this approach");
  });

  it("parses llm.invoke with single-quoted prompt", () => {
    const cmd = parsePipelineCommand("llm.invoke --prompt 'Do the thing'");
    expect(cmd.name).toBe("llm.invoke");
    expect(cmd.args.prompt).toBe("Do the thing");
  });

  it("parses boolean flags", () => {
    const cmd = parsePipelineCommand("llm.invoke --refresh --prompt test");
    expect(cmd.args.refresh).toBe(true);
    expect(cmd.args.prompt).toBe("test");
  });

  it("handles empty input", () => {
    expect(() => parsePipelineCommand("")).toThrow("Empty pipeline");
  });
});

describe("resolveArgsTemplate", () => {
  it("replaces ${argName} with arg values", () => {
    const result = resolveArgsTemplate("Task: ${task}", { task: "fix auth" });
    expect(result).toBe("Task: fix auth");
  });

  it("leaves unmatched templates intact", () => {
    const result = resolveArgsTemplate("${missing} stuff", {});
    expect(result).toBe("${missing} stuff");
  });
});

describe("resolveStepRef", () => {
  it("resolves $stepId.json references", () => {
    const results = { orient: { id: "orient", json: { mode: "single" } } };
    const value = resolveStepRef("$orient.json", results);
    expect(value).toEqual({ mode: "single" });
  });

  it("resolves $stepId.stdout references", () => {
    const results = { orient: { id: "orient", stdout: "hello" } };
    const value = resolveStepRef("$orient.stdout", results);
    expect(value).toBe("hello");
  });

  it("resolves $stepId.approved references", () => {
    const results = { gate: { id: "gate", approved: true } };
    const value = resolveStepRef("$gate.approved", results);
    expect(value).toBe(true);
  });

  it("throws on unknown step", () => {
    expect(() => resolveStepRef("$missing.json", {})).toThrow("Unknown step reference");
  });

  it("returns non-ref strings as-is", () => {
    const value = resolveStepRef("plain text", {});
    expect(value).toBe("plain text");
  });
});

describe("resolveStdin", () => {
  it("resolves step refs", () => {
    const results = { a: { id: "a", json: [1, 2, 3] } };
    const value = resolveStdin("$a.json", {}, results);
    expect(value).toEqual([1, 2, 3]);
  });

  it("resolves arg templates", () => {
    const value = resolveStdin("Task: ${task}", { task: "fix it" }, {});
    expect(value).toBe("Task: fix it");
  });

  it("returns null for null/undefined", () => {
    expect(resolveStdin(null, {}, {})).toBeNull();
    expect(resolveStdin(undefined, {}, {})).toBeNull();
  });

  it("passes through non-string values", () => {
    expect(resolveStdin(42, {}, {})).toBe(42);
  });
});

describe("loadWorkflow", () => {
  let tmpDir: string;

  async function writeWorkflow(content: string): Promise<string> {
    tmpDir = await mkdtemp(join(tmpdir(), "lobster-test-"));
    const filePath = join(tmpDir, "test.lobster");
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  it("parses a minimal workflow", async () => {
    const path = await writeWorkflow(`
name: test
steps:
  - id: step1
    run: echo hello
`);
    const wf = await loadWorkflow(path);
    expect(wf.name).toBe("test");
    expect(wf.steps).toHaveLength(1);
    expect(wf.steps[0].run).toBe("echo hello");
    await rm(tmpDir, { recursive: true });
  });

  it("rejects duplicate step ids", async () => {
    const path = await writeWorkflow(`
name: test
steps:
  - id: dup
    run: echo 1
  - id: dup
    run: echo 2
`);
    await expect(loadWorkflow(path)).rejects.toThrow("Duplicate step id");
    await rm(tmpDir, { recursive: true });
  });

  it("rejects steps with no execution type", async () => {
    const path = await writeWorkflow(`
name: test
steps:
  - id: empty
`);
    await expect(loadWorkflow(path)).rejects.toThrow("requires run, command, pipeline");
    await rm(tmpDir, { recursive: true });
  });

  it("parses parallel branches", async () => {
    const path = await writeWorkflow(`
name: test
steps:
  - id: par
    parallel:
      branches:
        - id: a
          run: echo a
        - id: b
          run: echo b
`);
    const wf = await loadWorkflow(path);
    expect(wf.steps[0].parallel?.branches).toHaveLength(2);
    expect(wf.steps[0].parallel?.branches[0].id).toBe("a");
    await rm(tmpDir, { recursive: true });
  });

  it("parses approval-only steps", async () => {
    const path = await writeWorkflow(`
name: test
steps:
  - id: gate
    approval: Please confirm
`);
    const wf = await loadWorkflow(path);
    expect(wf.steps[0].approval).toBe("Please confirm");
    await rm(tmpDir, { recursive: true });
  });
});
