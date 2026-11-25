import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("saves gateway durations through the API and reloads the saved settings", async () => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "https://aigc.test");
  const initial = { idleTimeoutMinutes: 30, maxSessionHours: 8, launchTicketSeconds: 60 };
  const updated = { idleTimeoutMinutes: 45, maxSessionHours: 6, launchTicketSeconds: 90 };
  let settings = { ...initial, changes: [] };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "https://aigc.test/api/gateway-settings/grants") return Response.json([]);
    if (url !== "https://aigc.test/api/gateway-settings") throw new Error(`Unexpected URL: ${url}`);
    if (init?.method === "PUT") {
      settings = { ...JSON.parse(String(init.body)), changes: [] };
      return Response.json(settings);
    }
    return Response.json(settings);
  });
  vi.stubGlobal("fetch", fetcher);
  const { default: GatewaySettingsPage } = await import("./page");
  const user = userEvent.setup();
  render(<GatewaySettingsPage />);

  const save = screen.getByRole("button", { name: "保存配置" });
  await waitFor(() => expect(save).toBeEnabled());
  const durations = [
    [screen.getByRole("spinbutton", { name: "空闲超时" }), updated.idleTimeoutMinutes],
    [screen.getByRole("spinbutton", { name: "会话最长时长" }), updated.maxSessionHours],
    [screen.getByRole("spinbutton", { name: "启动票据有效期" }), updated.launchTicketSeconds],
  ] as const;
  for (const [input, value] of durations) {
    await user.clear(input);
    await user.type(input, String(value));
  }
  await user.click(save);

  expect(await screen.findByText(/已保存。/)).toBeInTheDocument();
  await waitFor(() => expect(save).toBeEnabled());
  const settingsRequests = fetcher.mock.calls.filter(([url]) => url.endsWith("/api/gateway-settings"));
  expect(settingsRequests).toHaveLength(3);
  expect(settingsRequests[1][1]).toMatchObject({ method: "PUT", body: JSON.stringify(updated) });
  for (const [input, value] of durations) {
    expect(input).toHaveValue(value);
  }
});
