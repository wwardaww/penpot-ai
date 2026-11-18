import { test, expect } from "@playwright/test";
import { LoginPage } from "../pages/LoginPage";

// W11 security checks of the Penforge pairing link (`wiki/architecture.md` §3):
// the daemon token lives only in sessionStorage, never in localStorage, and does
// not stay in the address bar or the history entry. No daemon runs in the e2e
// suite, so its WebSocket is answered by a silent stub.

const TOKEN = "w11-e2e-token_0123456789";

test.beforeEach(async ({ page }) => {
  await LoginPage.init(page);
  await LoginPage.mockConfigFlags(page, ["enable-ai"]);
  await page.routeWebSocket(/:4410\/agent/, () => {});

  const login = new LoginPage(page);
  await login.setupLoggedInUser();
});

test("Penforge pairing link stores the token in this tab only", async ({
  page,
}) => {
  await page.goto(`/#/penforge/pair?token=${TOKEN}`);

  await expect(
    page.getByRole("heading", { name: "Penforge is paired" }),
  ).toBeVisible();

  const storage = await page.evaluate(() => ({
    session: window.sessionStorage.getItem("penforge.token"),
    local: Object.keys(window.localStorage).filter((key) =>
      window.localStorage.getItem(key)?.includes("w11-e2e-token"),
    ),
  }));
  expect(storage.session).toBe(TOKEN);
  expect(storage.local).toEqual([]);
});

test("Penforge pairing link removes the token from the address bar", async ({
  page,
}) => {
  await page.goto(`/#/penforge/pair?token=${TOKEN}`);

  await expect(
    page.getByRole("heading", { name: "Penforge is paired" }),
  ).toBeVisible();
  await expect.poll(() => page.url()).not.toContain(TOKEN);
});

test("Penforge pairing link without a token is refused", async ({ page }) => {
  await page.goto("/#/penforge/pair?token=");

  await expect(
    page.getByRole("heading", { name: "This pairing link is not valid" }),
  ).toBeVisible();
  const session = await page.evaluate(() =>
    window.sessionStorage.getItem("penforge.token"),
  );
  expect(session).toBeNull();
});
