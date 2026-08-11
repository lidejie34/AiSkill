/**
 * validate-token.ts
 *
 * 验证 Jean token 是否有效。
 *
 * 用法：
 *   # 验证缓存中的 token
 *   node --experimental-strip-types scripts/validate-token.ts
 *
 *   # 传入新 token，验证通过后自动写入缓存
 *   node --experimental-strip-types scripts/validate-token.ts --token <TOKEN>
 *
 * 输出（JSON）：
 *   { "valid": true,  "token": "xxx..." }   — 验证通过，退出码 0
 *   { "valid": false, "reason": "..." }      — 验证失败，退出码 1
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const SKILL_DIR = path.resolve(import.meta.dirname, "..");
const TOKEN_PATH = path.join(SKILL_DIR, "assets", "jean-token");
const VALIDATE_URL =
  "http://jean.17usoft.com/api/group/appUksByGitUrl?gitUrl=test";

/* ---------- helpers ---------- */

function output(obj: Record<string, unknown>, exitCode: number): never {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(exitCode);
}

function httpGet(
  url: string,
  headers: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      // 消费响应体，防止内存泄漏
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error("请求超时（10s）"));
    });
  });
}

/* ---------- main ---------- */

async function main() {
  // 解析参数
  const args = process.argv.slice(2);
  let token: string | undefined;

  const tokenFlagIndex = args.indexOf("--token");
  if (tokenFlagIndex !== -1) {
    token = args[tokenFlagIndex + 1];
    if (!token) {
      output({ valid: false, reason: "缺少 --token 的值" }, 1);
    }
  }

  // 若未传入 token，从缓存读取
  if (!token) {
    try {
      token = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
    } catch {
      // 文件不存在或不可读
    }
    if (!token) {
      output({ valid: false, reason: "缓存文件不存在或为空" }, 1);
    }
  }

  // 验证 token
  try {
    const statusCode = await httpGet(VALIDATE_URL, { "jean-token": token! });

    if (statusCode === 401) {
      output({ valid: false, reason: "token 无效（HTTP 401）" }, 1);
    }

    // 验证通过 —— 若是通过 --token 传入的，写入缓存
    if (tokenFlagIndex !== -1) {
      fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
      fs.writeFileSync(TOKEN_PATH, token!, "utf-8");
    }

    output({ valid: true, token: token! }, 0);
  } catch (err: any) {
    output({ valid: false, reason: `请求失败: ${err.message}` }, 1);
  }
}

main();
