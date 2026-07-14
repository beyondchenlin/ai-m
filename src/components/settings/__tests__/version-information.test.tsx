// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PublicBuildMetadata } from "@/lib/build-metadata";
import { VersionInformation } from "../version-information";

const messages = {
  common: { appName: "AI Comic Builder" },
  settings: {
    versionInfo: {
      title: "About",
      description: "Build identity for support and diagnostics.",
      version: "Version",
      commit: "Commit",
      buildTime: "Build time",
      development: "Development",
      notProvided: "Not provided",
      copy: "Copy version information",
      copied: "Version information copied",
      copyFailed: "Could not copy version information",
    },
  },
} as const;

function renderVersionInformation(metadata: PublicBuildMetadata = {
  version: "1.2.3",
  commit: "abcdef0123456789",
  buildTime: "2026-07-14T12:34:56.000Z",
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <VersionInformation metadata={metadata} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VersionInformation", () => {
  it("renders accessible build metadata with a compact responsive definition list", () => {
    const { container } = renderVersionInformation();

    expect(screen.getByRole("heading", { name: "About" })).toBeTruthy();
    expect(screen.getByText("Build identity for support and diagnostics.")).toBeTruthy();
    const list = container.querySelector("dl");
    expect(list).not.toBeNull();
    expect(list?.className).toContain("grid-cols-1");
    expect(list?.className).toContain("sm:grid-cols-3");
    expect(within(list as HTMLElement).getByText("Version").tagName).toBe("DT");
    expect(within(list as HTMLElement).getByText("1.2.3").tagName).toBe("DD");
    expect(within(list as HTMLElement).getByText("abcdef012345").getAttribute("title"))
      .toBe("abcdef0123456789");
    expect(within(list as HTMLElement).getByText("2026-07-14T12:34:56.000Z")).toBeTruthy();

    const copy = screen.getByRole("button", { name: "Copy version information" });
    expect(copy.className).toContain("h-11");
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("renders localized deterministic fallbacks when optional metadata is absent", () => {
    renderVersionInformation({ version: "1.2.3", commit: null, buildTime: null });

    expect(screen.getByText("Development")).toBeTruthy();
    expect(screen.getByText("Not provided")).toBeTruthy();
  });

  it("copies the localized summary with the complete commit", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderVersionInformation();

    await userEvent.click(screen.getByRole("button", { name: "Copy version information" }));

    expect(writeText).toHaveBeenCalledWith(
      "AI Comic Builder — Version 1.2.3; Commit abcdef0123456789; Build time 2026-07-14T12:34:56.000Z",
    );
    await waitFor(() => expect(screen.getByRole("status").textContent)
      .toBe("Version information copied"));
  });

  it("announces clipboard failure without exposing metadata in an error", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard unavailable"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderVersionInformation();

    await userEvent.click(screen.getByRole("button", { name: "Copy version information" }));

    await waitFor(() => expect(screen.getByRole("status").textContent)
      .toBe("Could not copy version information"));
  });
});
