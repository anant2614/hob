// Browser checks of `pnpm demo` in Chromium: what the workerd tests can't see.
// Layout on a desktop and a phone, the memory drawer, Stop, New topic, a frame
// lost on a dead socket, the reload hint, and a server killed mid-tool (a
// deploy) resuming its answer. Playwright is not a project dependency:
//
//   npm install -g playwright && npx playwright install chromium   # once
//   NODE_PATH="$(npm root -g)" node test/e2e/browser-check.cjs [screenshot-dir]
//
// It starts and stops the demo itself, on PORT (default 5199), from a clean state.
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.resolve(__dirname, "../..");
const port = Number(process.env.PORT ?? 5199);
const base = `http://localhost:${port}/`;
const shots = path.resolve(process.argv[2] ?? path.join(repo, "test-results/browser"));
const problems = [];
const pageErrors = [];

function startDemo() {
  const log = fs.openSync(path.join(shots, "demo.log"), "a");
  const child = spawn("pnpm", ["demo", "--port", String(port), "--strictPort"], {
    cwd: repo,
    detached: true,
    stdio: ["ignore", log, log]
  });
  child.unref();
  return child;
}

async function stopDemo(child) {
  try {
    process.kill(-child.pid, "SIGKILL"); // the whole group: pnpm, Vite and workerd
  } catch {}
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(base);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitForDemo() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("the demo did not start; see demo.log");
}

async function step(name, run) {
  const started = Date.now();
  try {
    await run();
    console.log(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    console.log(`FAIL ${name}: ${String(error.message ?? error).split("\n")[0]}`);
    problems.push(name);
  }
}

async function send(page, text) {
  const box = page.getByLabel("Message Hob");
  await box.fill(text);
  await box.press("Enter");
}

async function openPage(browser, options) {
  const page = await (await browser.newContext(options)).newPage();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  // Vite's HMR socket would reload the page when the demo restarts; a deploy drops only Hob's socket.
  await page.routeWebSocket(/\?token=/, () => {});
  return page;
}

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  fs.rmSync(path.join(repo, "test/e2e/.wrangler/state"), { recursive: true, force: true });
  let demo = startDemo();
  await waitForDemo();
  const browser = await chromium.launch();

  const page = await openPage(browser, { viewport: { width: 1280, height: 860 }, colorScheme: "light" });
  // Hob's own socket goes through a relay that can lose one frame, as a dead socket would.
  let loseNext = false;
  await page.routeWebSocket(/\/chat/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (loseNext && String(message).includes('"type":"submit"')) {
        loseNext = false;
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => socket.send(message));
  });

  await step("loads, connects and offers a first message", async () => {
    await page.goto(base);
    await page.getByText(/^Ready\./).waitFor({ timeout: 30_000 });
    await page.getByRole("img", { name: "Hob is here" }).waitFor();
    await page.getByText("Tell Hob something worth remembering, or give it a link to read.").waitFor();
  });
  await page.screenshot({ path: path.join(shots, "1-empty-desktop.png") });

  await step("remember shows a tool note and an answer, and updates memory", async () => {
    await send(page, "remember coffee: Flat white with oat milk");
    await page.getByText("Saved “coffee”").waitFor({ timeout: 15_000 });
    await page.getByText('tool said: Saved memory "coffee".').waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: /Memory, 1 saved/ }).waitFor();
  });

  await step("read_page marks the conversation as including web pages", async () => {
    await send(page, "read https://example.com/post");
    await page.getByText("Read example.com/post").waitFor({ timeout: 15_000 });
    await page.getByText("Includes web pages").waitFor({ timeout: 15_000 });
  });

  await step("a page's push to another host is refused", async () => {
    await send(page, "follow");
    await page.getByText("Didn't open evil.example.net/collect").waitFor({ timeout: 15_000 });
    await page.getByText(/^Ready\./).waitFor({ timeout: 15_000 });
  });

  await step("a tool note opens to show what came back", async () => {
    await page.getByText("Read example.com/post").click();
    await page.getByText("From the web. Hob treats it as information, not instructions.").waitFor();
  });
  await page.screenshot({ path: path.join(shots, "2-conversation-desktop.png") });

  await step("Stop interrupts a running tool", async () => {
    await send(page, "slow");
    await page.getByText(/^Working/).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Stop the answer" }).click();
    await page.getByText(/^Ready\./).waitFor({ timeout: 15_000 });
    await page.getByText("test_gate stopped").waitFor({ timeout: 15_000 });
  });

  await step("the transcript survives a reload", async () => {
    await page.reload();
    await page.getByText(/^Ready\./).waitFor({ timeout: 30_000 });
    await page.getByText("Saved “coffee”").waitFor();
  });

  await step("a message lost on a dead socket is sent again on a fresh one", async () => {
    loseNext = true;
    await send(page, "lost in transit");
    await page.waitForTimeout(1_500);
    if ((await page.getByText("echo: lost in transit").count()) > 0) throw new Error("the lost frame was answered");
    await page.getByText("echo: lost in transit").waitFor({ timeout: 25_000 });
  });

  await step("the memory drawer edits, adds in any script, and keeps a refused entry", async () => {
    await page.getByRole("button", { name: /Memory, 1 saved/ }).click();
    const drawer = page.getByRole("dialog", { name: "Memory" });
    await drawer.getByRole("button", { name: "Edit" }).click();
    await drawer.getByLabel("Text of coffee").fill("Flat white, oat milk, no sugar");
    await drawer.getByRole("button", { name: "Save", exact: true }).click();
    await drawer.getByText("Flat white, oat milk, no sugar").waitFor();
    await drawer.getByText(/Added by you on/).waitFor();

    await drawer.getByLabel("Name").fill("José");
    await drawer.getByLabel("What Hob should know").fill("My neighbour, plays the cello");
    await drawer.getByRole("button", { name: "Save memory" }).click();
    await drawer.getByText("josé", { exact: true }).waitFor({ timeout: 10_000 });
    if ((await drawer.getByLabel("Name").inputValue()) !== "") throw new Error("the form kept a saved entry");

    await drawer.getByLabel("Name").fill("!!!");
    await drawer.getByLabel("What Hob should know").fill("Nothing usable in the key");
    await drawer.getByRole("button", { name: "Save memory" }).click();
    await drawer.getByRole("alert").waitFor({ timeout: 10_000 });
    if ((await drawer.getByLabel("What Hob should know").inputValue()) !== "Nothing usable in the key") {
      throw new Error("the form lost a refused entry");
    }
    if ((await page.locator(".dock .alert").count()) > 0) throw new Error("the error also landed behind the drawer");
  });
  await page.screenshot({ path: path.join(shots, "3-memory-desktop.png") });
  await page.keyboard.press("Escape");

  const phone = await openPage(browser, {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: "dark"
  });
  await step("phone: the same conversation, in dark mode", async () => {
    await phone.goto(base);
    await phone.getByText(/^Ready\./).waitFor({ timeout: 30_000 });
    await phone.getByText("Saved “coffee”").waitFor();
  });
  await phone.screenshot({ path: path.join(shots, "4-conversation-phone-dark.png") });

  await step("phone: the memory drawer fits, and nothing scrolls sideways", async () => {
    await phone.getByRole("button", { name: /Memory, 2 saved/ }).click();
    const box = await phone.getByRole("dialog", { name: "Memory" }).boundingBox();
    if (!box || box.width > 390.5) throw new Error(`the drawer is ${box?.width}px wide`);
    await phone.screenshot({ path: path.join(shots, "5-memory-phone-dark.png") });
    await phone.keyboard.press("Escape");
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) throw new Error(`the page overflows by ${overflow}px`);
  });
  await phone.close();

  await step("New topic clears the conversation and the web-page mark", async () => {
    await page.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "New topic" }).click();
    await page.getByRole("menuitem", { name: "Start new topic" }).click();
    await page.getByText("Includes web pages").waitFor({ state: "detached", timeout: 15_000 });
    await page.getByText("Tell Hob something worth remembering, or give it a link to read.").waitFor({ timeout: 15_000 });
  });
  await page.screenshot({ path: path.join(shots, "6-new-topic-desktop.png") });

  await step("a deploy mid-tool: the answer resumes on the restarted server", async () => {
    await send(page, "slow");
    await page.getByText(/^Working/).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(500);
    await stopDemo(demo);
    await page.getByText("Connection lost. Reconnecting…").waitFor({ timeout: 15_000 });
    await page.screenshot({ path: path.join(shots, "7-connection-lost.png") });
    demo = startDemo();
    await waitForDemo();
    await page.getByText("Resuming the answer that was cut off…").waitFor({ timeout: 30_000 });
    await page.screenshot({ path: path.join(shots, "8-resuming.png") });
    // The gate tool never finishes by itself; Stop ends the resumed run.
    await page.getByRole("button", { name: "Stop the answer" }).click();
    await page.getByText(/^Ready\./).waitFor({ timeout: 20_000 });
  });

  await step("reconnects that keep failing suggest a reload, until one works", async () => {
    await stopDemo(demo);
    await page.getByText("Can't reach Hob. If you were signed out, reload to sign in again.").waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Reload" }).waitFor();
    await page.screenshot({ path: path.join(shots, "9-reload-hint.png") });
    demo = startDemo();
    await waitForDemo();
    await page.getByText(/^Ready\./).waitFor({ timeout: 60_000 });
    if ((await page.getByRole("button", { name: "Reload" }).count()) > 0) throw new Error("Reload is still offered");
  });

  await browser.close();
  await stopDemo(demo);
  console.log(`page errors: ${pageErrors.length}`);
  for (const error of pageErrors.slice(0, 10)) console.log(`  ${error.slice(0, 300)}`);
  console.log(`screenshots: ${shots}`);
  const passed = problems.length === 0 && pageErrors.length === 0;
  console.log(passed ? "BROWSER CHECK PASSED" : `BROWSER CHECK FAILED: ${problems.join(", ") || "page errors"}`);
  process.exit(passed ? 0 : 1);
})().catch((error) => {
  console.error("CRASHED", error);
  process.exit(1);
});
