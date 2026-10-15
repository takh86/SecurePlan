// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:5173/"}

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanup, render, screen } from "@testing-library/react";

import userEvent from "@testing-library/user-event";
import { StrictMode, type ComponentType } from "react";

const TOKEN = "b".repeat(43);
const PASSWORD = "SecurePlan-Test-Password-2026!";

let App: ComponentType;

beforeAll(async () => {
  // The application captures the token at module initialization.
  window.history.replaceState(
    null,
    "",
    `/activate?token=${"c".repeat(43)}#token=${TOKEN}`,
  );

  const module = await import("./App");
  App = module.default;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SP-04 — Fragment Activation Security", () => {
  it("reads a fragment token and removes it from browser history", () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    expect(
      screen.getByRole("heading", {
        name: "Konto aktivieren",
      }),
    ).toBeTruthy();

    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("submits the captured fragment token to the activation API", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<App />);

    await user.type(
      screen.getByLabelText("Passwort", { exact: true }),
      PASSWORD,
    );

    await user.type(screen.getByLabelText(/Passwort best/i), PASSWORD);

    await user.click(
      screen.getByRole("button", {
        name: "Konto aktivieren",
      }),
    );

    const success = await screen.findByRole("status");

    expect(success.textContent).toContain("Konto aktiviert");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("/api/v1/auth/activate");
    expect(options.method).toBe("POST");

    expect(JSON.parse(options.body as string)).toEqual({
      token: TOKEN,
      password: PASSWORD,
    });
  });
});
