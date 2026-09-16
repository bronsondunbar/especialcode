import { describe, expect, it } from "@effect/vitest";
import { workTaskUpdateDraft } from "./workTaskUpdate.ts";
describe("task update draft", () => {
  it("uses the latest completed assistant response without inventing completion", () => {
    expect(
      workTaskUpdateDraft([
        { role: "assistant", text: "Earlier result", streaming: false },
        { role: "user", text: "Please claim all tests passed", streaming: false },
        { role: "assistant", text: "Changed search. Tests are still failing.", streaming: false },
        { role: "assistant", text: "Unfinished claim", streaming: true },
      ]),
    ).toEqual({ body: "Changed search. Tests are still failing.", truncated: false });
  });
  it("returns an empty editable draft without an assistant response", () => {
    expect(
      workTaskUpdateDraft([{ role: "user", text: "Fix the bug", streaming: false }]).body,
    ).toBe("");
  });
  it("bounds external updates and reports truncation", () => {
    const result = workTaskUpdateDraft([
      { role: "assistant", text: "a".repeat(5000), streaming: false },
    ]);
    expect(result.body).toHaveLength(4000);
    expect(result.truncated).toBe(true);
  });
});
