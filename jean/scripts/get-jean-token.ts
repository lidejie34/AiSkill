#!/usr/bin/env node
/**
 * 自动获取 Jean token（jean_v2）并写入 assets/jean-token
 *
 * 运行方式：
 * node --experimental-strip-types scripts/get-jean-token.ts
 *
 * 可选环境变量：
 * - JEAN_URL: Jean 页面地址，默认 https://jean.corp.elong.com/v3/access/#/plat
 * - JEAN_TOKEN_FILE: token 输出路径，默认 ../assets/jean-token
 * - JEAN_TOKEN_TIMEOUT_MS: 等待登录后抓取 token 的超时毫秒数，默认 180000
 * - JEAN_CHROME_PROFILE_DIR: Chrome 持久化 profile 目录，默认 ~/.codex/jean-token-chrome-profile
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");

type Cookie = { name: string; value: string };
type BrowserContext = {
  pages(): Array<{ goto: (url: string, options?: Record<string, unknown>) => Promise<void> }>;
  newPage(): Promise<{ goto: (url: string, options?: Record<string, unknown>) => Promise<void> }>;
  cookies(urls?: string[]): Promise<Cookie[]>;
  close(): Promise<void>;
};
type ChromiumModule = {
  launchPersistentContext: (
    userDataDir: string,
    options?: Record<string, unknown>,
  ) => Promise<BrowserContext>;
};

const SCRIPT_DIR = __dirname;
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_TOKEN_FILE = path.join(SKILL_DIR, "assets", "jean-token");
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), ".codex", "jean-token-chrome-profile");
const JEAN_URL = process.env.JEAN_URL || "https://jean.corp.elong.com/v3/access/#/plat";
const TOKEN_FILE = process.env.JEAN_TOKEN_FILE || DEFAULT_TOKEN_FILE;
const PROFILE_DIR = process.env.JEAN_CHROME_PROFILE_DIR || DEFAULT_PROFILE_DIR;
const TOKEN_TIMEOUT_MS = Number(process.env.JEAN_TOKEN_TIMEOUT_MS || "180000");
const TOKEN_POLL_INTERVAL_MS = 2000;

function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function printHelp(): void {
  console.log("用法:");
  console.log("  node --experimental-strip-types scripts/get-jean-token.ts");
  console.log("");
  console.log("说明:");
  console.log("  1) 自动打开 Chrome 访问 Jean 页面");
  console.log("  2) 用户在浏览器手动点击登录");
  console.log("  3) 脚本自动读取 jean_v2 并写入 assets/jean-token");
  console.log("");
  console.log("可选环境变量:");
  console.log("  JEAN_URL, JEAN_TOKEN_FILE, JEAN_TOKEN_TIMEOUT_MS, JEAN_CHROME_PROFILE_DIR");
}

async function loadChromium(): Promise<ChromiumModule> {
  const candidates = [
    "playwright",
    "/Users/Apple/.codex/skills/elong-login-info/node_modules/playwright",
  ];
  for (const mod of candidates) {
    try {
      const loaded = require(mod);
      if (loaded && loaded.chromium && loaded.chromium.launchPersistentContext) {
        return loaded.chromium as ChromiumModule;
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    "未找到 playwright。请先在可用环境安装（npm i playwright）或确保本机已有可用的 playwright 模块。",
  );
}

async function readJeanToken(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies([JEAN_URL]);
  const tokenCookie = cookies.find((cookie) => cookie.name === "jean_v2" && cookie.value);
  return tokenCookie?.value || null;
}

async function validateToken(token: string): Promise<{ ok: boolean; status: number | string }> {
  try {
    const resp = await fetch("http://jean.17usoft.com/api/group/appUksByGitUrl?gitUrl=test", {
      method: "GET",
      headers: { "jean-token": token },
    });
    return { ok: resp.status !== 401 && resp.ok, status: resp.status };
  } catch (error) {
    return { ok: false, status: `network-error: ${(error as Error).message}` };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const chromium = await loadChromium();
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log(`[INFO] 使用 profile: ${PROFILE_DIR}`);
  console.log(`[INFO] 目标页面: ${JEAN_URL}`);

  let context: BrowserContext | null = null;
  try {
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        channel: "chrome",
      });
    } catch {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
      });
    }

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();
    await page.goto(JEAN_URL, { waitUntil: "domcontentloaded", timeout: 120000 });

    let token = await readJeanToken(context);
    if (!token) {
      console.log("[INFO] 未检测到 jean_v2，请在浏览器中完成登录，脚本将自动检测...");
      const deadline = Date.now() + TOKEN_TIMEOUT_MS;
      let elapsed = 0;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, TOKEN_POLL_INTERVAL_MS));
        token = await readJeanToken(context);
        if (token) break;
        elapsed += TOKEN_POLL_INTERVAL_MS;
        if (elapsed % 10000 === 0) {
          console.log(`[INFO] 仍在等待登录... (已等待 ${Math.floor(elapsed / 1000)}s)`);
        }
      }
    }

    if (!token) {
      throw new Error(
        `超时仍未检测到 jean_v2（等待 ${Math.floor(TOKEN_TIMEOUT_MS / 1000)} 秒）。`,
      );
    }

    fs.writeFileSync(TOKEN_FILE, token, "utf8");
    console.log(`[OK] token 已写入: ${TOKEN_FILE}`);
    console.log(`[OK] token 摘要: ${maskToken(token)}`);

    const validation = await validateToken(token);
    if (validation.ok) {
      console.log(`[OK] token 校验通过（status=${validation.status}）`);
    } else {
      console.log(
        `[WARN] token 已写入，但校验未通过（status=${validation.status}）。请确认已登录 Jean 内网并重试。`,
      );
    }
  } finally {
    if (context) {
      await context.close();
    }
  }
}

main().catch((error) => {
  console.error(`[ERR] ${(error as Error).message}`);
  process.exit(1);
});
