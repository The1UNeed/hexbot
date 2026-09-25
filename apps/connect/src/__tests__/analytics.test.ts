import { describe, expect, it } from "vitest";
import { parseChoice, STORAGE_KEY } from "@/lib/analytics";

describe("consent", () => {
  it("shares the site's storage key and accepts only the two answers", () => {
    expect(STORAGE_KEY).toBe("hexbot-analytics");
    expect(parseChoice("granted")).toBe("granted");
    expect(parseChoice("denied")).toBe("denied");
    expect(parseChoice("yes")).toBeNull();
    expect(parseChoice(null)).toBeNull();
  });
});
