import { describe, expect, it } from "vitest";
import { formatBytes } from "@/lib/format";

describe("formatBytes", () => {
  it("handles zero and junk", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("picks the unit by dividing, so exact powers of 1024 land on the right unit", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
    expect(formatBytes(1024 ** 5)).toBe("1.0 PB");
    // Telegram's channel ceiling: 2^31 posts × 512 MiB parts = 2^60 bytes.
    expect(formatBytes(2 ** 31 * 512 * 1024 ** 2)).toBe("1.0 EB");
    expect(formatBytes(2 ** 53 - 1)).toBe("8.0 PB");
  });

  it("carries values that round up to 1024 into the next unit", () => {
    expect(formatBytes(1024 * 1024 - 1)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3 - 1024)).toBe("1.0 GB");
    expect(formatBytes(1023.4 * 1024)).toBe("1023 KB");
  });

  it("keeps one decimal below 100 and none above", () => {
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(formatBytes(99.94 * 1024 ** 2)).toBe("99.9 MB");
    expect(formatBytes(250 * 1024 ** 2)).toBe("250 MB");
  });

  it("stays in EB beyond the last unit", () => {
    expect(formatBytes(4096 * 1024 ** 6)).toBe("4096 EB");
  });
});
