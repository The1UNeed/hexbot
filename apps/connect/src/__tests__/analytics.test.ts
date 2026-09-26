import { describe, expect, it } from "vitest";
import { isSensitivePath, parseChoice, scrubEvent, STORAGE_KEY } from "@/lib/analytics";

describe("consent", () => {
  it("shares the site's storage key and accepts only the two answers", () => {
    expect(STORAGE_KEY).toBe("hexbot-analytics");
    expect(parseChoice("granted")).toBe("granted");
    expect(parseChoice("denied")).toBe("denied");
    expect(parseChoice("yes")).toBeNull();
    expect(parseChoice(null)).toBeNull();
  });
});

describe("what leaves the browser", () => {
  it("cuts every URL property down to its path, so codes and states never reach PostHog", () => {
    const event = scrubEvent({ event: "$pageview", properties: {
      $current_url: "https://connect.hexbot.app/connect/approve?code=ABCD-EFGH",
      $referrer: "https://connect.hexbot.app/connect/authorize?state=s&device=d#x",
      $pathname: "/connect/approve",
      $set: { $initial_current_url: "https://connect.hexbot.app/connect/browser?daemon=1&code_challenge=c" },
      $set_once: { $initial_referrer: "$direct" },
    } });
    expect(event.properties).toEqual({
      $current_url: "https://connect.hexbot.app/connect/approve",
      $referrer: "https://connect.hexbot.app/connect/authorize",
      $pathname: "/connect/approve",
      $set: { $initial_current_url: "https://connect.hexbot.app/connect/browser" },
      $set_once: { $initial_referrer: "$direct" },
    });
  });
  it("names the pages that never get session replay", () => {
    for (const path of ["/connect/approve", "/connect/authorize", "/connect/browser", "/connect/browser/"]) expect(isSensitivePath(path)).toBe(true);
    for (const path of ["/", "/connect", "/sign-in"]) expect(isSensitivePath(path)).toBe(false);
  });
});
