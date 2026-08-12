import { describe, it, expect } from "vitest";
import { STAGES } from "../src/types";

describe("infra smoke", () => {
  it("imports shared types", () => {
    expect(STAGES[0]).toBe("not_started");
    expect(STAGES.at(-1)).toBe("merged");
  });
});
