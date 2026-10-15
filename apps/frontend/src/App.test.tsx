// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:5173/"}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import userEvent from "@testing-library/user-event";

import { StrictMode, type ComponentType } from "react";

const TOKEN = "a".repeat(43);
const PASSWORD = "SecurePlan-Test-Password-2026!";

let App: ComponentType;

beforeEach(async () => {
  vi.resetModules();
  // The application reads the token when its module loads.
  window.history.replaceState(null, "", `/activate?token=${TOKEN}`);

  const module = await import("./App");
  App = module.default;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function fillActivationForm() {
  const user = userEvent.setup();

  await user.type(screen.getByLabelText("Passwort", { exact: true }), PASSWORD);

  await user.type(screen.getByLabelText("Passwort bestätigen"), PASSWORD);

  return user;
}

describe("SP-04 — React Account Activation", () => {
  it("renders the activation form and removes the token from the URL", () => {
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

    expect(screen.getByLabelText("Passwort", { exact: true })).toBeTruthy();

    expect(screen.getByLabelText("Passwort bestätigen")).toBeTruthy();

    expect(screen.getByText(
      "Mindestens 15 Zeichen. Passwortmanager und Einf\u00fcgen sind erlaubt.",
    )).toBeTruthy();

    expect(window.location.search).toBe("");
  });

  it("disables submission until passwords are valid and matching", async () => {
    const user = userEvent.setup();

    render(<App />);

    const button = screen.getByRole("button", {
      name: "Konto aktivieren",
    }) as HTMLButtonElement;

    expect(button.disabled).toBe(true);

    await user.type(
      screen.getByLabelText("Passwort", { exact: true }),
      PASSWORD,
    );

    expect(button.disabled).toBe(true);

    await user.type(screen.getByLabelText("Passwort bestätigen"), PASSWORD);

    expect(button.disabled).toBe(false);
  });

  it("activates an account and displays the success state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const user = await fillActivationForm();

    await user.click(
      screen.getByRole("button", {
        name: "Konto aktivieren",
      }),
    );

    const success = await screen.findByRole("status");

    expect(success.textContent).toContain("Konto aktiviert");
    expect(success.textContent?.replace(/\s+/g, " ")).toContain(
      "Ihr Passwort wurde eingerichtet. Sie k\u00f6nnen sich anmelden, sobald die Anmeldung verf\u00fcgbar ist.",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("/api/v1/auth/activate");
    expect(options.method).toBe("POST");
    expect(options.credentials).toBe("omit");
    expect(options.cache).toBe("no-store");
    expect(options.referrerPolicy).toBe("no-referrer");

    expect(JSON.parse(options.body as string)).toEqual({
      token: TOKEN,
      password: PASSWORD,
    });
  });

  it("displays an invalid-link message for an invalid token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: "ACTIVATION_TOKEN_INVALID_OR_EXPIRED",
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/problem+json",
            },
          },
        ),
      ),
    );

    render(<App />);

    const user = await fillActivationForm();

    await user.click(
      screen.getByRole("button", {
        name: "Konto aktivieren",
      }),
    );

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("Aktivierungslink ungültig");

    expect(
      screen.queryByRole("button", {
        name: "Konto aktivieren",
      }),
    ).toBeNull();
  });

  it("shows a safe message when the network is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Private network diagnostic")),
    );

    render(<App />);

    const user = await fillActivationForm();

    await user.click(
      screen.getByRole("button", {
        name: "Konto aktivieren",
      }),
    );

    const alert = await screen.findByRole("alert");

    expect(alert.textContent).toContain("Verbindung fehlgeschlagen");

    expect(alert.textContent).not.toContain("Private network diagnostic");
  });

  it("shows loading, disables all fields and prevents duplicate submission", async () => {
    let complete!: (response: Response) => void;
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    const user = await fillActivationForm();
    const password = screen.getByLabelText("Passwort", {
      exact: true,
    }) as HTMLInputElement;
    const confirmation = screen.getByLabelText(
      "Passwort bestätigen",
    ) as HTMLInputElement;
    const form = password.form!;

    await user.click(screen.getByRole("button", { name: "Konto aktivieren" }));
    expect(
      (
        screen.getByRole("button", {
          name: /Konto wird aktiviert/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(password.disabled).toBe(true);
    expect(confirmation.disabled).toBe(true);
    fireEvent.submit(form);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      complete(new Response(null, { status: 200 }));
    });
    expect((await screen.findByRole("status")).textContent).toContain(
      "Konto aktiviert",
    );
    expect(screen.queryByLabelText("Passwort", { exact: true })).toBeNull();
  });

  it("allows a manual retry after a network failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Synthetic network failure"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    const user = await fillActivationForm();

    await user.click(screen.getByRole("button", { name: "Konto aktivieren" }));
    await screen.findByRole("alert");
    expect(
      (
        screen.getByRole("button", {
          name: "Konto aktivieren",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Konto aktivieren" }));
    await screen.findByRole("status");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      status: 400,
      code: "PASSWORD_POLICY_VIOLATION",
      message: "Passwort nicht zulässig",
    },
    { status: 429, code: "RATE_LIMITED", message: "Zu viele Anfragen" },
    {
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: "Dienst vorübergehend nicht verfügbar",
    },
  ])(
    "shows a safe recoverable state for $code",
    async ({ status, code, message }) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code,
            detail: "Synthetic private diagnostic",
          }),
          { status, headers: { "content-type": "application/problem+json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      render(<App />);
      const user = await fillActivationForm();
      await user.click(
        screen.getByRole("button", { name: "Konto aktivieren" }),
      );

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(message);
      expect(alert.textContent!.includes("Synthetic private diagnostic")).toBe(
        false,
      );
      expect(alert.textContent!.includes(TOKEN)).toBe(false);
      expect(alert.textContent!.includes(PASSWORD)).toBe(false);
      expect(
        (
          screen.getByRole("button", {
            name: "Konto aktivieren",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("renders a missing link as invalid without making an API request", async () => {
    vi.resetModules();
    window.history.replaceState(null, "", "/activate");
    const MissingTokenApp = (await import("./App")).default;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <StrictMode>
        <MissingTokenApp />
      </StrictMode>,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Aktivierungslink ungültig",
    );
    expect(screen.queryByLabelText("Passwort", { exact: true })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([14, 15, 128])(
    "enforces the %i-character form boundary",
    async (length) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      render(<App />);
      const password = screen.getByLabelText("Passwort", { exact: true });
      const confirmation = screen.getByLabelText("Passwort bestätigen");
      fireEvent.change(password, { target: { value: "z".repeat(length) } });
      fireEvent.change(confirmation, { target: { value: "z".repeat(length) } });
      expect(
        (
          screen.getByRole("button", {
            name: "Konto aktivieren",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(length < 15);
      expect((password as HTMLInputElement).maxLength).toBe(128);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
