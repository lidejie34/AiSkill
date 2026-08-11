/**
 * get-appuk.ts
 *
 * 通过 git 仓库地址识别 Jean 平台的 appUk。
 *
 * 用法：
 *   # 自动从当前仓库获取 git remote URL
 *   node --experimental-strip-types scripts/get-appuk.ts
 *
 *   # 手动指定 git URL
 *   node --experimental-strip-types scripts/get-appuk.ts --git-url <GIT_URL>
 *
 *   # 手动指定 token（默认从缓存读取）
 *   node --experimental-strip-types scripts/get-appuk.ts --token <TOKEN>
 *
 * 输出（JSON）：
 *   成功（退出码 0）：
 *   {
 *     "success": true,
 *     "count": 1,
 *     "gitUrl": "https://...",
 *     "apps": [ { "appUk": "xxx", "appName": "yyy", ... } ]
 *   }
 *
 *   失败（退出码 1）：
 *   { "success": false, "reason": "..." }
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const SKILL_DIR = path.resolve(import.meta.dirname, "..");
const TOKEN_PATH = path.join(SKILL_DIR, "assets", "jean-token");
const API_BASE = "http://jean.17usoft.com/api/group/appUksByGitUrl";

/* ---------- helpers ---------- */

function output(obj: Record<string, unknown>, exitCode: number): never {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(exitCode);
}

function httpGetJson(
  url: string,
  headers: Record<string, string>
): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let body: any;
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
        resolve({ statusCode: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error("请求超时（15s）"));
    });
  });
}

function getGitRemoteUrl(): string | null {
  try {
    return execSync("git remote get-url origin", {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/* ---------- parse args ---------- */

function parseArgs(): { gitUrl?: string; token?: string } {
  const args = process.argv.slice(2);
  const result: { gitUrl?: string; token?: string } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--git-url" && args[i + 1]) {
      result.gitUrl = args[++i];
    } else if (args[i] === "--token" && args[i + 1]) {
      result.token = args[++i];
    }
  }
  return result;
}

/* ---------- main ---------- */

async function main() {
  const opts = parseArgs();

  // 获取 token
  let token = opts.token;
  if (!token) {
    try {
      token = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
    } catch {
      // ignore
    }
  }
  if (!token) {
    output(
      {
        success: false,
        reason:
          "未找到 jean-token，请先执行 validate-token.ts 或通过 --token 参数传入",
      },
      1
    );
  }

  // 获取 git URL
  let gitUrl = opts.gitUrl;
  if (!gitUrl) {
    gitUrl = getGitRemoteUrl() ?? undefined;
  }
  if (!gitUrl) {
    output(
      {
        success: false,
        reason:
          "无法获取 git 仓库地址：当前目录不是 git 仓库，或 remote origin 不存在。请通过 --git-url 参数指定。",
      },
      1
    );
  }

  // 调用 API
  const url = `${API_BASE}?gitUrl=${encodeURIComponent(gitUrl!)}`;

  try {
    const { statusCode, body } = await httpGetJson(url, {
      "jean-token": token!,
    });

    if (statusCode === 401) {
      output({ success: false, reason: "token 无效（HTTP 401），请重新获取" }, 1);
    }

    // 解析响应 —— 兼容 body 可能是数组或 { data: [...] } 的情况
    const apps: any[] = Array.isArray(body)
      ? body
      : Array.isArray(body?.data)
        ? body.data
        : [];

    output(
      {
        success: true,
        count: apps.length,
        gitUrl: gitUrl!,
        apps,
      },
      apps.length > 0 ? 0 : 1
    );
  } catch (err: any) {
    output({ success: false, reason: `请求失败: ${err.message}` }, 1);
  }
}

main();
