import { describe, expect, it } from "vitest";
import { statusLabel } from "@/app/connect/daemon-row";

const daemon = { id: "d1", name: "Studio", hostname: "studio.example", status: "offline" as const, openUrl: "https://studio.example" };

describe("daemon status label", () => {
  // "Last seen" moves only while someone looks, so an offline row gives no time that could be days stale.
  it("says only Offline for a daemon that is not answering", () => expect(statusLabel(daemon)).toBe("Offline"));
  it("says Online and Removing… as before", () => {
    expect(statusLabel({ ...daemon, status: "online" })).toBe("Online");
    expect(statusLabel({ ...daemon, removing: true })).toBe("Removing…");
  });
});
