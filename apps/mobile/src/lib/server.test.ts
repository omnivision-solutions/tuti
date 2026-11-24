import { describe, expect, it } from "vitest";

import { hostOf, normalizeServer } from "./server";

describe("a server's address", () => {
  it("is the origin of what's typed, https unless http is", () => {
    expect(normalizeServer("feedback.acme.com")).toBe("https://feedback.acme.com");
    expect(normalizeServer("  https://Feedback.Acme.com/app/inbox/?x=1 ")).toBe("https://feedback.acme.com");
    expect(normalizeServer("HTTP://192.168.1.20:3000/")).toBe("http://192.168.1.20:3000");
    expect(normalizeServer("localhost:3000")).toBe("https://localhost:3000");
    expect(normalizeServer("http://[::1]:3000")).toBe("http://[::1]:3000");
  });

  it("isn't anything else", () => {
    for (const typed of ["", "   ", "ftp://acme.com", "acme..com", "acme.com.", "-", "me@acme.com", "https://", "tuti://sign-in"]) {
      expect(normalizeServer(typed), typed).toBeNull();
    }
  });

  it("shows as its host", () => {
    expect(hostOf("https://tuti.so")).toBe("tuti.so");
    expect(hostOf("http://localhost:3000/api/v1/projects")).toBe("localhost:3000");
  });
});
