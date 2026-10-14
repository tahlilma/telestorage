import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type FileChooser, type Page, type Route } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DriveNode } from "@/lib/types";
import { BASE, Client, PASSWORD, sleep } from "./client";

/**
 * The real UI in real Chrome against a running server: every upload control,
 * duplicate handling, sharing (password, view-only, several items), instant
 * actions on a slow network, live sync, phones. Screenshots land in UI_SHOTS.
 */
const SHOTS = process.env.UI_SHOTS ?? null;
const launchOptions = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" as const };
/** The suite needs a local Chrome (or CHROME_PATH); without one it is skipped, not failed. */
const canLaunch = await chromium
  .launch(launchOptions)
  .then(async (b) => (await b.close(), true))
  .catch((e) => (console.warn(`UI suite skipped — cannot start Chrome: ${(e as Error).message.split("\n")[0]}`), false));
const problems: string[] = [];
const api = new Client();
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let bay: DriveNode;
let emptyBay: DriveNode;

/** Records console errors. A visitor on a password-protected link gets 401s by design (locked, wrong password). */
function watch(p: Page, label: string, opts: { locked?: boolean } = {}) {
  p.on("console", (m) => {
    if (m.type() !== "error") return;
    if (opts.locked && /status of 401/.test(m.text())) return;
    problems.push(`[${label}] console: ${m.text()}`);
  });
  p.on("pageerror", (e) => problems.push(`[${label}] pageerror: ${e.message}`));
}

const shot = async (name: string, p: Page = page) => {
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

const card = (p: Page, name: string) => p.locator("[data-node-id]", { hasText: name });

/** Clicks something and requires the native file chooser to open. */
async function opensPicker(label: string, act: () => Promise<unknown>, p: Page = page): Promise<FileChooser> {
  const chooser = p.waitForEvent("filechooser", { timeout: 4000 }).catch(() => null);
  await act();
  const fc = await chooser;
  expect(fc, `${label} must open the native file picker`).not.toBeNull();
  return fc!;
}

const closePicker = async (fc: FileChooser) => {
  await fc.setFiles([]).catch(() => {});
};

async function pngs(p: Page, specs: [string, number, number, string, string][]) {
  const data = await p.evaluate(async (list) => {
    const out: string[] = [];
    for (const [, w, h, a, b] of list) {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, a);
      grad.addColorStop(1, b);
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      g.fillStyle = "rgba(255,255,255,0.35)";
      g.beginPath();
      g.arc(w * 0.7, h * 0.35, Math.min(w, h) * 0.18, 0, Math.PI * 2);
      g.fill();
      out.push(c.toDataURL("image/png").split(",")[1]);
    }
    return out;
  }, specs);
  return specs.map(([name], i) => ({ name, mimeType: "image/png", buffer: Buffer.from(data[i], "base64") }));
}

/** Waits until the upload panel shows `count` rows, all finished (any terminal state). */
const waitForUploads = (p: Page, count: number, timeout = 90_000) =>
  p.waitForFunction(
    (n) => {
      const rows = [...document.querySelectorAll<HTMLElement>("[data-testid=upload-row]")];
      return rows.length >= n && rows.every((r) => ["done", "deduped", "exists", "skipped"].includes(r.dataset.status ?? ""));
    },
    count,
    { timeout },
  );

const rowFor = (p: Page, name: string) => p.locator("[data-testid=upload-row]", { hasText: name });

beforeAll(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  if (!canLaunch) return;
  browser = await chromium.launch(launchOptions);
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  watch(page, "tab1");
  await api.login();
  bay = await api.mkdir(`Design review ${Date.now().toString(36)}`);
  emptyBay = await api.mkdir("Empty folder", bay.id);
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

describe.skipIf(!canLaunch)("Telestorage in a real browser", () => {
  it("signs in", async () => {
    await page.goto(BASE + "/");
    await page.waitForURL(/\/login/);
    await page.locator("input[type=password]").waitFor();
    await sleep(400);
    await shot("01-login");
    await page.fill("input[type=password]", PASSWORD);
    await page.getByRole("button", { name: /^Sign in/ }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    await page.getByTestId("home").waitFor();
  });

  it("opens the native file picker from every upload control — even in an empty folder", async () => {
    // Home first.
    const home = await opensPicker("home: hero Upload", () => page.getByTestId("home-upload").click());
    await closePicker(home);
    const qa = await opensPicker("home: quick action", () => page.getByTestId("qa-upload").click());
    await closePicker(qa);

    await page.goto(`${BASE}/folder/${emptyBay.id}`);
    await page.getByTestId("empty-upload").waitFor();
    await sleep(400);
    await shot("02-empty-folder");

    const checks: [string, () => Promise<unknown>][] = [
      ["empty state: Upload files", () => page.getByTestId("empty-upload").click()],
      ["empty state: Upload a folder", () => page.getByTestId("empty-upload-folder").click()],
      ["header: Upload", () => page.getByTestId("upload-button").click()],
      [
        "header: dropdown → Upload a folder",
        async () => {
          await page.getByRole("button", { name: "More upload options" }).click();
          await page.getByRole("menuitem", { name: "Upload a folder" }).click();
        },
      ],
      ["sidebar: Upload", () => page.getByTestId("sidebar-upload").click()],
      [
        "sidebar: + → Upload a folder",
        async () => {
          await page.getByRole("button", { name: "More: new folder or folder upload" }).click();
          await page.getByRole("menuitem", { name: "Upload a folder" }).click();
        },
      ],
      [
        "folder title menu → Upload files",
        async () => {
          await page.getByTestId("crumb-menu").click();
          await page.getByRole("menuitem", { name: /Upload files/ }).click();
        },
      ],
      [
        "right-click on empty space → Upload files",
        async () => {
          const box = (await page.getByTestId("file-browser").boundingBox())!;
          await page.mouse.click(box.x + 40, box.y + box.height - 40, { button: "right" });
          await page.getByRole("menuitem", { name: /Upload files/ }).click();
        },
      ],
      ["keyboard: Shift+U", () => page.keyboard.press("Shift+U")],
    ];
    for (const [label, act] of checks) {
      const fc = await opensPicker(label, act);
      await closePicker(fc);
      await page.keyboard.press("Escape");
      await sleep(150);
    }

    // Phones: the raised + button in the tab bar.
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await mobile.addCookies(await ctx.cookies());
    const phone = await mobile.newPage();
    watch(phone, "phone");
    await phone.goto(`${BASE}/folder/${emptyBay.id}`);
    await phone.getByTestId("fab").waitFor();
    await sleep(400);
    await shot("03-phone-empty", phone);
    const fc = await opensPicker(
      "phone: + → Upload files",
      async () => {
        await phone.getByTestId("fab").tap();
        await phone.getByRole("menuitem", { name: "Upload files" }).tap();
      },
      phone,
    );
    await closePicker(fc);
    await mobile.close();
  }, 120_000);

  it("creates a folder from the empty state", async () => {
    await page.getByTestId("empty-new-folder").click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await sleep(250);
    await shot("04-new-folder");
    await dialog.locator("input").fill("Receipts");
    await page.getByTestId("name-submit").click();
    await card(page, "Receipts").waitFor({ timeout: 3000 });
  });

  const big = crypto.randomBytes(13 * 1024 * 1024 + 4321);

  it("uploads through the picker: chunked, hashed, verified, byte-exact", async () => {
    await page.goto(`${BASE}/folder/${bay.id}`);
    await page.getByTestId("upload-button").waitFor();
    const images = await pngs(page, [
      ["sunset.png", 1600, 1000, "#ff7e5f", "#feb47b"],
      ["ocean.png", 1200, 1200, "#2193b0", "#6dd5ed"],
      ["forest.png", 1000, 1500, "#134e5e", "#71b280"],
      ["aurora.png", 1600, 900, "#00c9ff", "#92fe9d"],
    ]);
    const files = [...images, { name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("Telestorage plan\n".repeat(400)) }, { name: "payload.bin", mimeType: "application/octet-stream", buffer: big }];
    const fc = await opensPicker("header: Upload", () => page.getByTestId("upload-button").click());
    await fc.setFiles(files);
    await page.getByTestId("upload-panel").waitFor();
    await sleep(500);
    await shot("05-uploading");
    await waitForUploads(page, files.length);
    await sleep(300);
    await shot("06-uploaded");
    for (const f of files) await card(page, f.name).waitFor({ timeout: 10_000 });
    const listing = await api.listing(bay.id);
    const payload = listing.find((n) => n.name === "payload.bin")!;
    const back = await api.download(payload);
    expect(crypto.createHash("sha256").update(back.data).digest("hex")).toBe(crypto.createHash("sha256").update(big).digest("hex"));
  }, 150_000);

  it("re-uploading the same files asks first, and stores nothing twice", async () => {
    const images = await pngs(page, [["sunset.png", 1600, 1000, "#ff7e5f", "#feb47b"]]);
    const changed = { name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("A different plan\n".repeat(300)) };
    const fc = await opensPicker("re-upload", () => page.getByTestId("upload-button").click());
    await fc.setFiles([...images, changed, { name: "payload.bin", mimeType: "application/octet-stream", buffer: big }]);
    // The names are taken: we're asked what to do.
    const list = page.getByTestId("conflict-list");
    await list.waitFor();
    expect(await list.locator("li").count()).toBe(3);
    await sleep(250);
    await shot("07-duplicate-prompt");
    await page.getByTestId("conflict-keep").click();
    await page.getByTestId("conflict-continue").click();
    // Identical files land on what is there; the changed one is kept as "(1)".
    await rowFor(page, "payload.bin").and(page.locator("[data-status=exists]")).waitFor({ timeout: 60_000 });
    await rowFor(page, "sunset.png").and(page.locator("[data-status=exists]")).waitFor({ timeout: 30_000 });
    await rowFor(page, "plan.txt").and(page.locator("[data-outcome=renamed]")).waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await api.listing(bay.id)).map((n) => n.name).sort()).toEqual(
      ["Empty folder", "aurora.png", "forest.png", "ocean.png", "payload.bin", "plan (1).txt", "plan.txt", "sunset.png"].sort(),
    );
    await card(page, "plan (1).txt").waitFor();
    await sleep(300);
    await shot("08-duplicate-results");

    // Replace: same file, new content; the old content goes into its version history.
    const before = (await api.listing(bay.id)).find((n) => n.name === "plan (1).txt")!;
    const fc2 = await opensPicker("replace", () => page.getByTestId("upload-button").click());
    await fc2.setFiles([{ name: "plan (1).txt", mimeType: "text/plain", buffer: Buffer.from("third version\n") }]);
    await page.getByTestId("conflict-replace").click();
    await page.getByTestId("conflict-continue").click();
    await rowFor(page, "plan (1).txt").and(page.locator("[data-outcome=replaced]")).waitFor({ timeout: 30_000 });
    const after = (await api.listing(bay.id)).find((n) => n.name === "plan (1).txt")!;
    expect(after.id).toBe(before.id);
    expect(after.versionCount).toBe(1);
    await page.getByRole("button", { name: "Close uploads" }).click();
  }, 150_000);

  it("keeps version history: see it, restore an earlier version", async () => {
    await card(page, "plan (1).txt").click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Version history/ }).click();
    const dialog = page.getByRole("dialog");
    await expect.poll(() => dialog.getByTestId("version-row").count()).toBe(1);
    await sleep(300);
    await shot("08b-versions");
    await dialog.getByTestId("restore-version").click();
    await page.getByText(/Restored an earlier version/).first().waitFor();
    await expect.poll(async () => (await api.listing(bay.id)).find((n) => n.name === "plan (1).txt")?.size).toBe(Buffer.from("A different plan\n".repeat(300)).length);
  });

  it("colours a folder", async () => {
    await card(page, "Empty folder").click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Colour/ }).click();
    await sleep(250);
    await shot("08c-colour");
    await page.getByTestId("color-blue").click();
    const box = card(page, "Empty folder").locator("div[style]").first();
    await expect.poll(() => box.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(47, 93, 168)");
    await expect.poll(async () => (await api.listing(bay.id)).find((n) => n.name === "Empty folder")?.color).toBe("blue");
  });

  it("continues an upload after a reload instead of starting over", async () => {
    // A real file on disk, so it keeps its modification time like any file you'd pick again.
    const big = crypto.randomBytes(24 * 1024 * 1024 + 777);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "telestorage-ui-")), "archive.zip");
    fs.writeFileSync(file, big);
    let landed = 0;
    const onResponse = (r: import("playwright-core").Response) => {
      if (r.request().method() === "PUT" && r.url().includes("/api/uploads/") && r.status() === 200) landed++;
    };
    page.on("response", onResponse);
    const slow = async (r: Route) => {
      await sleep(700);
      await r.continue();
    };
    await page.route("**/api/uploads/*?part=*", slow);
    const fc = await opensPicker("upload", () => page.getByTestId("upload-button").click());
    await fc.setFiles(file);
    await expect.poll(() => landed, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
    // Close the tab mid-upload (the page asks first: uploads are running).
    await page.unroute("**/api/uploads/*?part=*", slow);
    page.off("response", onResponse);
    page.once("dialog", (d) => void d.accept());
    await page.reload();
    const row = rowFor(page, "archive.zip");
    await row.and(page.locator("[data-status=interrupted]")).waitFor({ timeout: 15_000 });
    await sleep(300);
    await shot("08a-interrupted");
    // Picking the same file again continues it: only the missing bytes are sent.
    let resent = 0;
    const count = (r: import("playwright-core").Request) => {
      if (r.method() === "PUT" && r.url().includes("/api/uploads/")) resent += r.postDataBuffer()?.length ?? 0;
    };
    page.on("request", count);
    const again = await opensPicker("upload again", () => page.getByTestId("upload-button").click());
    await again.setFiles(file);
    await row.and(page.locator("[data-status=done]")).waitFor({ timeout: 60_000 });
    page.off("request", count);
    expect(await row.getAttribute("data-resumed")).toBe("true");
    expect(resent).toBeGreaterThan(0);
    expect(resent).toBeLessThan(big.length);
    const node = (await api.listing(bay.id)).find((n) => n.name === "archive.zip")!;
    const back = await api.download(node);
    expect(back.data.equals(big)).toBe(true);
    await page.getByRole("button", { name: "Close uploads" }).click();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }, 120_000);

  it("shows details with integrity and sharing", async () => {
    await card(page, "payload.bin").click();
    await page.keyboard.press("i");
    const badge = page.getByTestId("integrity-badge");
    await badge.waitFor();
    expect(["pending", "verified"]).toContain(await badge.getAttribute("data-state"));
    await sleep(300);
    await shot("09-details");
    await page.keyboard.press("i");
  });

  it("shares with a password and view-only; the visitor sees exactly that", async () => {
    await card(page, "sunset.png").click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Share/ }).click();
    await page.getByRole("switch", { name: /Require a password/ }).click();
    await page.getByLabel("Link password").fill("letmein");
    await page.getByRole("switch", { name: /Allow downloads/ }).click();
    await page.locator("#share-note").fill("Sunset from the trip");
    await sleep(200);
    await shot("10-share-options");
    await page.getByTestId("create-link").click();
    await page.getByTestId("share-qr").waitFor();
    const url = (await page.getByTestId("share-url").textContent())!.trim();
    expect(url).toMatch(/\/s\/[A-Za-z0-9]{16,}$/);
    await sleep(300);
    await shot("11-share-result");
    await page.keyboard.press("Escape");

    const visitor = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const v = await visitor.newPage();
    watch(v, "visitor", { locked: true });
    await v.goto(url);
    await v.getByTestId("share-locked").waitFor();
    await sleep(300);
    await shot("12-share-locked", v);
    await v.getByLabel("Link password").fill("wrong");
    await v.getByRole("button", { name: /Open/ }).click();
    await v.getByText("Wrong password").waitFor();
    await v.getByLabel("Link password").fill("letmein");
    await v.getByRole("button", { name: /Open/ }).click();
    await v.getByTestId("view-only").waitFor();
    await v.getByTestId("share-note").waitFor();
    expect(await v.getByTestId("share-download").count()).toBe(0);
    await sleep(500);
    await shot("13-share-visitor", v);
    await visitor.close();
  });

  it("shares several items as one link", async () => {
    await card(page, "ocean.png").click();
    await card(page, "forest.png").click({ modifiers: ["Control"] });
    await page.getByTestId("selection-bar").waitFor();
    await page.getByTestId("selection-bar").getByRole("button", { name: "Share" }).click();
    await page.getByLabel(/Link name/).fill("Trip photos");
    await page.getByTestId("create-link").click();
    const url = (await page.getByTestId("share-url").textContent())!.trim();
    await page.keyboard.press("Escape");
    const visitor = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const v = await visitor.newPage();
    watch(v, "visitor2");
    await v.goto(url);
    await v.getByText("Trip photos").first().waitFor();
    await expect.poll(() => v.getByTestId("share-item").count()).toBe(2);
    expect(await v.getByTestId("share-download").count()).toBe(1);
    await sleep(500);
    await shot("14-share-bundle", v);
    await visitor.close();
  });

  it("lists links on the Shared page and turns one off", async () => {
    await page.getByRole("button", { name: "Shared links" }).first().click();
    await expect.poll(() => page.getByTestId("share-row").count()).toBeGreaterThanOrEqual(2);
    await sleep(400);
    await shot("15-shared-links");
    const row = page.getByTestId("share-row").filter({ hasText: "Trip photos" });
    const url = await row.locator("a", { hasText: "Open" }).getAttribute("href");
    await row.getByRole("button", { name: /Turn off/ }).click();
    await row.getByRole("button", { name: /Turn off\?/ }).click();
    await page.getByText("Link turned off").first().waitFor();
    const visitor = await browser.newContext();
    const v = await visitor.newPage();
    await v.goto(url!);
    await v.getByTestId("share-gone").waitFor();
    await visitor.close();
  });

  it("answers every primary action instantly, even on a slow network", async () => {
    await page.goto(`${BASE}/folder/${bay.id}`);
    await card(page, "aurora.png").waitFor();
    const slow = async (r: Route) => {
      if (r.request().method() === "GET") return r.continue();
      await sleep(1000);
      await r.continue();
    };
    await page.route("**/api/nodes/**", slow);
    await page.route("**/api/nodes", slow);
    const within = async (label: string, ms: number, fn: () => Promise<unknown>) => {
      const t0 = performance.now();
      await fn();
      const took = performance.now() - t0;
      expect(took, `${label} took ${Math.round(took)} ms`).toBeLessThan(ms);
    };

    await card(page, "aurora.png").click();
    await page.keyboard.press("F2");
    const input = page.getByRole("dialog").locator("input");
    await input.fill("aurora-borealis.png");
    await within("rename", 500, async () => {
      await input.press("Enter");
      await card(page, "aurora-borealis.png").waitFor({ timeout: 500 });
    });

    await card(page, "sunset.png").click();
    await within("star", 500, async () => {
      await page.keyboard.press("s");
      await card(page, "sunset.png").locator("svg.fill-accent").first().waitFor({ timeout: 500 });
    });

    await card(page, "ocean.png").click();
    await within("trash", 400, async () => {
      await page.keyboard.press("Delete");
      await card(page, "ocean.png").waitFor({ state: "detached", timeout: 400 });
    });
    await page.getByRole("button", { name: "Undo" }).first().click();
    await card(page, "ocean.png").waitFor({ timeout: 5000 });

    await card(page, "aurora-borealis.png").click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Move to…/ }).click();
    const move = page.getByRole("dialog");
    await move.getByRole("button", { name: "Empty folder", exact: true }).click();
    await within("move", 500, async () => {
      await move.getByRole("button", { name: /^Move to/ }).click();
      await card(page, "aurora-borealis.png").waitFor({ state: "detached", timeout: 500 });
    });
    await page.unroute("**/api/nodes/**", slow);
    await page.unroute("**/api/nodes", slow);
    await sleep(1200);

    await page.keyboard.press("/");
    await page.keyboard.type("borealis");
    await page.locator("button", { hasText: "aurora-borealis.png" }).first().waitFor({ timeout: 5000 });
    await sleep(250);
    await shot("16-search");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/search\?q=borealis/);
    await card(page, "aurora-borealis.png").dblclick();
    const preview = page.getByRole("dialog", { name: /Preview of aurora-borealis\.png/ });
    await preview.waitFor();
    await sleep(500);
    await shot("17-preview");
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "detached" });
    await page.keyboard.press("?");
    await page.getByRole("dialog", { name: "Shortcuts" }).waitFor();
    await page.keyboard.press("Escape");
  }, 90_000);

  it("deletes instantly, never lets the item flicker back, and confirms removal from Telegram", async () => {
    await page.goto(`${BASE}/folder/${bay.id}`);
    await card(page, "plan.txt").waitFor();
    await page.route("**/api/nodes/batch", async (r) => {
      await sleep(1500);
      await r.continue();
    });
    const target = card(page, "plan.txt");
    await target.click();
    const t0 = performance.now();
    await page.keyboard.press("Delete");
    await target.waitFor({ state: "detached", timeout: 400 });
    const ms = performance.now() - t0;
    for (let i = 0; i < 35; i++) {
      expect(await target.count()).toBe(0);
      await sleep(100);
    }
    console.log("optimistic delete", Math.round(ms), "ms");
    await page.getByText(/moved to trash/).first().waitFor();

    const doomed = card(page, "forest.png");
    await doomed.click();
    await page.keyboard.press("Shift+Delete");
    await page.getByTestId("confirm-delete").waitFor();
    await sleep(250);
    await shot("18-delete-confirm");
    await page.getByTestId("confirm-delete").click();
    await doomed.waitFor({ state: "detached", timeout: 400 });
    await page.getByText("Removed from Telegram too.").first().waitFor({ timeout: 15_000 });
    await page.unroute("**/api/nodes/batch");

    await page.getByRole("button", { name: "Trash" }).first().click();
    const trashed = card(page, "plan.txt");
    await trashed.waitFor();
    await sleep(300);
    await shot("19-trash");
    await trashed.click();
    await page.keyboard.press("Delete");
    await page.getByTestId("confirm-delete").click();
    await trashed.waitFor({ state: "detached", timeout: 400 });
  }, 60_000);

  it("syncs live across tabs and devices", async () => {
    await page.goto(`${BASE}/folder/${bay.id}`);
    await card(page, "sunset.png").waitFor();
    await page.getByTestId("live-badge").filter({ hasText: "Live" }).waitFor({ timeout: 10_000 });
    const tab2 = await ctx.newPage();
    watch(tab2, "tab2");
    await tab2.goto(`${BASE}/folder/${bay.id}`);
    await card(tab2, "sunset.png").waitFor();
    const other = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await other.addCookies(await ctx.cookies());
    const device = await other.newPage();
    watch(device, "device2");
    await device.goto(`${BASE}/folder/${bay.id}`);
    await card(device, "sunset.png").waitFor();
    await device.getByTestId("live-badge").filter({ hasText: "Live" }).waitFor({ timeout: 10_000 });

    await api.mkdir("Made elsewhere", bay.id);
    for (const p of [page, tab2, device]) await card(p, "Made elsewhere").waitFor({ timeout: 8_000 });
    await card(page, "ocean.png").click();
    await page.keyboard.press("Delete");
    for (const p of [tab2, device]) await card(p, "ocean.png").waitFor({ state: "detached", timeout: 8_000 });
    // The activity bell lights up on the other device.
    await device.getByRole("button", { name: "Activity (new)" }).waitFor({ timeout: 8_000 });
    await tab2.close();
    await other.close();
  }, 60_000);

  it("shows where the space goes, then system status and its integrity check", async () => {
    await page.getByTestId("storage-card").click();
    await page.getByTestId("storage-page").waitFor();
    await page.getByTestId("biggest-files").getByText("archive.zip").first().waitFor();
    await sleep(900);
    await shot("19a-storage");
    await page.getByRole("button", { name: /System status/ }).click();
    await page.getByTestId("tower-status").filter({ hasText: "Live" }).waitFor({ timeout: 15_000 });
    await page.getByTestId("limits").waitFor();
    await page.getByTestId("limits").scrollIntoViewIfNeeded();
    await sleep(400);
    await shot("20a-system-limits");
    await page.getByTestId("run-fsck").click();
    await page.getByTestId("fsck-checks").waitFor({ timeout: 15_000 });
    await sleep(700);
    await shot("20-system");
  }, 60_000);

  it("collects files from someone else through a file request", async () => {
    await page.goto(`${BASE}/folder/${bay.id}`);
    await card(page, "Empty folder").click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Request files/ }).click();
    await page.getByLabel(/What are you asking for/).fill("Holiday pictures");
    await page.locator("#share-note").fill("Send me yours!");
    await page.getByTestId("create-request").click();
    const url = (await page.getByTestId("share-url").textContent())!.trim();
    expect(url).toMatch(/\/r\/[A-Za-z0-9]{16,}$/);
    await page.keyboard.press("Escape");

    const visitor = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const v = await visitor.newPage();
    watch(v, "requester");
    await v.goto(url);
    await v.getByTestId("request-page").waitFor();
    await v.getByText("Holiday pictures").first().waitFor();
    await sleep(500);
    await shot("30-request-page", v);
    await v.getByLabel(/Your name/).fill("Sam");
    await v.getByTestId("request-input").setInputFiles([
      { name: "beach.txt", mimeType: "text/plain", buffer: Buffer.from("sand\n".repeat(1000)) },
      { name: "sunset-2.bin", mimeType: "application/octet-stream", buffer: crypto.randomBytes(3 * 1024 * 1024 + 5) },
    ]);
    await expect.poll(() => v.locator("[data-testid=request-row][data-status=done]").count(), { timeout: 60_000 }).toBe(2);
    await sleep(400);
    await shot("31-request-sent", v);
    await visitor.close();

    const inbox = (await api.listing(bay.id)).find((n) => n.name === "Empty folder")!;
    await expect.poll(async () => (await api.listing(inbox.id)).map((n) => n.name).sort()).toEqual(expect.arrayContaining(["beach.txt", "sunset-2.bin"]));
    await page.goto(`${BASE}/shared`);
    await page.getByRole("tab", { name: /File requests/ }).click();
    await page.getByTestId("request-received").filter({ hasText: "2 files received" }).waitFor();
    await sleep(300);
    await shot("32-requests-tab");
  }, 120_000);

  it("shows every photo on one timeline", async () => {
    await page.goto(`${BASE}/photos`);
    await page.getByTestId("photos").waitFor();
    // By now sunset.png and aurora-borealis.png are the live images (the others were deleted or trashed).
    await expect.poll(() => page.locator("[data-photo-id]").count()).toBeGreaterThanOrEqual(2);
    await sleep(900);
    await shot("33-photos");
    await page.locator("[data-photo-id]").first().click();
    await page.getByRole("dialog", { name: /Preview of/ }).waitFor();
    await page.keyboard.press("Escape");
  });

  it("goes anywhere from the command palette", async () => {
    await page.goto(`${BASE}/`);
    await page.getByTestId("home").waitFor();
    await page.keyboard.press("Control+k");
    await page.getByTestId("command-palette").waitFor();
    await page.getByTestId("palette-input").fill("stor");
    await sleep(250);
    await shot("34-palette");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/storage$/);
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("sunset");
    await page.getByTestId("palette-item").filter({ hasText: "sunset.png" }).first().click({ timeout: 8000 });
    await page.getByRole("dialog", { name: /Preview of sunset\.png/ }).waitFor();
    await page.keyboard.press("Escape");
  });

  it("downloads big files in parallel, straight to disk, checksum-verified", async () => {
    const dl = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await dl.addCookies(await ctx.cookies());
    // Stand-in for the OS save dialog: a file handle that records writes at their offsets.
    await dl.addInitScript(() => {
      const w = window as unknown as { __saved?: { size: number; data: Uint8Array; closed: boolean } };
      (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => ({
        createWritable: async () => {
          const file = { size: 0, data: new Uint8Array(0), closed: false };
          w.__saved = file;
          return {
            truncate: async (n: number) => {
              file.size = n;
              file.data = new Uint8Array(n);
            },
            write: async ({ position, data }: { position: number; data: Uint8Array }) => file.data.set(data, position),
            close: async () => {
              file.closed = true;
            },
            abort: async () => {},
          };
        },
      });
    });
    const p = await dl.newPage();
    watch(p, "downloader");
    await p.goto(`${BASE}/folder/${bay.id}`);
    await card(p, "archive.zip").click({ button: "right" });
    await p.getByRole("menuitem", { name: /^Download/ }).click();
    await p.locator("[data-testid=download-row][data-status=done]").waitFor({ timeout: 60_000 });
    await sleep(300);
    await shot("35-download", p);
    const saved = await p.evaluate(async () => {
      const s = (window as unknown as { __saved: { size: number; data: Uint8Array; closed: boolean } }).__saved;
      const digest = await window.crypto.subtle.digest("SHA-256", s.data as Uint8Array<ArrayBuffer>);
      return { size: s.size, closed: s.closed, sha: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("") };
    });
    const node = (await api.listing(bay.id)).find((n) => n.name === "archive.zip")!;
    const details = await api.json<{ storage: { sha256: string } }>("GET", `/api/nodes/${node.id}`);
    expect(saved).toEqual({ size: node.size, closed: true, sha: details.body.storage.sha256 });
    await dl.close();
  }, 90_000);

  it("receives files shared from another app (phone share sheet)", async () => {
    await page.goto(`${BASE}/`);
    await page.getByTestId("home").waitFor();
    // What the service worker does with a share: park the files in Cache Storage, then open /?received=<id>.
    await page.evaluate(async () => {
      const cache = await caches.open("telestorage-shared-v1");
      await cache.put(
        "/__shared/e2e/0",
        new Response(new Blob(["shared from the gallery app\n"], { type: "text/plain" }), { headers: { "x-name": encodeURIComponent("from-phone.txt"), "x-modified": "1700000000000" } }),
      );
    });
    await page.goto(`${BASE}/?received=e2e`);
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Save to Telestorage").waitFor();
    await sleep(250);
    await shot("36-receive");
    await dialog.getByTestId("move-confirm").click();
    await expect.poll(async () => (await api.listing("root")).some((n) => n.name === "from-phone.txt"), { timeout: 30_000 }).toBe(true);
  });

  it("looks right: home, grid, list, dark and on a phone", async () => {
    await page.goto(`${BASE}/`);
    await page.getByTestId("home").waitFor();
    await page.getByTestId("home-folder").first().waitFor();
    await sleep(1200);
    await shot("21-home");
    await page.goto(`${BASE}/folder/${bay.id}`);
    await card(page, "sunset.png").waitFor();
    await sleep(800);
    await shot("22-grid");
    await page.keyboard.press("v");
    await sleep(400);
    await shot("23-list");
    await page.keyboard.press("v");
    await page.evaluate(() => {
      const raw = localStorage.getItem("ts-prefs");
      const prefs = raw ? JSON.parse(raw) : { state: {}, version: 0 };
      prefs.state.theme = "dark";
      localStorage.setItem("ts-prefs", JSON.stringify(prefs));
    });
    await page.reload();
    await card(page, "sunset.png").waitFor();
    await sleep(800);
    await shot("24-dark-grid");
    await page.goto(`${BASE}/`);
    await page.getByTestId("home").waitFor();
    await sleep(1200);
    await shot("25-dark-home");
    await page.evaluate(() => {
      const prefs = JSON.parse(localStorage.getItem("ts-prefs")!);
      prefs.state.theme = "light";
      localStorage.setItem("ts-prefs", JSON.stringify(prefs));
    });

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    await mobile.addCookies(await ctx.cookies());
    const phone = await mobile.newPage();
    watch(phone, "phone2");
    await phone.goto(`${BASE}/`);
    await phone.getByTestId("home").waitFor();
    await sleep(1200);
    await shot("26-phone-home", phone);
    await phone.goto(`${BASE}/folder/${bay.id}`);
    await card(phone, "sunset.png").waitFor();
    await sleep(800);
    await shot("27-phone-files", phone);
    await phone.getByRole("button", { name: "More actions for sunset.png" }).tap();
    await phone.getByTestId("action-sheet").waitFor();
    await sleep(400);
    await shot("28-phone-actions", phone);
    await phone.getByTestId("action-sheet").getByRole("button", { name: /^Share/ }).tap();
    await phone.getByTestId("create-link").waitFor();
    await sleep(500);
    await shot("29-phone-share-sheet", phone);
    await mobile.close();
  }, 90_000);

  it("produced no console errors or uncaught exceptions", () => {
    expect(problems).toEqual([]);
  });
});
