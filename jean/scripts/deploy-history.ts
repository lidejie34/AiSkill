/**
 * deploy-history.ts
 *
 * 按 appUk + env 查询某时间范围内的历史部署记录。
 * 服务端从 furt 部署历史中逐页拉取并按部署开始时间过滤。
 *
 * 用法：
 *   node --experimental-strip-types scripts/deploy-history.ts \
 *     --appUk <appUk> \
 *     --env   <env> \
 *     [--startTime "yyyy-MM-dd HH:mm:ss"] \
 *     [--endTime   "yyyy-MM-dd HH:mm:ss"] \
 *     [--recentDays <n>] \
 *     [--token <jean-token>]
 *
 * 时间范围优先级：startTime+endTime（成对）> recentDays > 默认最近 7 天。
 *
 * 输出（JSON）：
 *   成功（退出码 0）：
 *   {
 *     "success": true,
 *     "appUk": "...",
 *     "env": "...",
 *     "count": N,
 *     "records": [ { appUk, env, opId, opType, status, user, version,
 *                    startTime, endTime, failCause, successCount,
 *                    failedCount, redeployCount, scaleOutCount, shrinkCount } ]
 *   }
 *
 *   失败（退出码 1）：
 *   { "success": false, "reason": "..." }
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const SKILL_DIR = path.resolve(import.meta.dirname, "..");
const TOKEN_PATH = path.join(SKILL_DIR, "assets", "jean-token");
const API_URL = "http://jean.17usoft.com/api/openapi/external/deploy-history";
const REQUEST_TIMEOUT = 30_000;
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/* ---------- helpers ---------- */

function output(obj: Record<string, unknown>, exitCode: number): never {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(exitCode);
}

function httpPostJson(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>
): Promise<{ statusCode: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(payload);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let body: any;
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
        resolve({ statusCode: res.statusCode ?? 0, body, raw });
      });
    });

    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy();
      reject(new Error("请求超时（30s）"));
    });
    req.write(data);
    req.end();
  });
}

/* ---------- parse args ---------- */

interface Options {
  token: string;
  appUk: string;
  env: string;
  startTime?: string;
  endTime?: string;
  recentDays?: number;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = { token: "", appUk: "", env: "" };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--token":
        opts.token = args[++i];
        break;
      case "--appUk":
        opts.appUk = args[++i];
        break;
      case "--env":
        opts.env = args[++i];
        break;
      case "--startTime":
        opts.startTime = args[++i];
        break;
      case "--endTime":
        opts.endTime = args[++i];
        break;
      case "--recentDays":
        opts.recentDays = parseInt(args[++i], 10);
        break;
      default:
        output({ success: false, reason: `未知参数: ${args[i]}` }, 1);
    }
  }

  if (!opts.token) {
    try {
      opts.token = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
    } catch {}
  }
  if (!opts.token) {
    output(
      {
        success: false,
        reason:
          "未找到 jean-token，请通过 --token 参数传入或先执行 validate-token.ts",
      },
      1
    );
  }
  if (!opts.appUk || !opts.env) {
    output({ success: false, reason: "缺少必填参数: --appUk, --env" }, 1);
  }

  // 时间区间必须成对传入
  if (Boolean(opts.startTime) !== Boolean(opts.endTime)) {
    output(
      {
        success: false,
        reason: "startTime/endTime 需成对传入，仅传其一无效",
      },
      1
    );
  }
  if (opts.startTime && !TIME_RE.test(opts.startTime)) {
    output(
      { success: false, reason: "startTime 格式应为 yyyy-MM-dd HH:mm:ss" },
      1
    );
  }
  if (opts.endTime && !TIME_RE.test(opts.endTime)) {
    output(
      { success: false, reason: "endTime 格式应为 yyyy-MM-dd HH:mm:ss" },
      1
    );
  }
  if (opts.startTime && opts.endTime && opts.endTime < opts.startTime) {
    output(
      { success: false, reason: "endTime 不得早于 startTime" },
      1
    );
  }
  if (
    opts.recentDays !== undefined &&
    (!Number.isInteger(opts.recentDays) || opts.recentDays <= 0)
  ) {
    output({ success: false, reason: "recentDays 应为正整数" }, 1);
  }

  return opts;
}

/* ---------- main ---------- */

async function main() {
  const opts = parseArgs();

  // 构造请求体，对齐服务端时间优先级：区间 > recentDays > 默认最近 7 天
  const payload: Record<string, unknown> = {
    appUk: opts.appUk,
    env: opts.env,
  };
  if (opts.startTime && opts.endTime) {
    payload.startTime = opts.startTime;
    payload.endTime = opts.endTime;
  } else if (opts.recentDays !== undefined) {
    payload.recentDays = opts.recentDays;
  }

  let resp;
  try {
    resp = await httpPostJson(API_URL, { "jean-token": opts.token }, payload);
  } catch (err: any) {
    output({ success: false, reason: `请求失败: ${err.message}` }, 1);
  }

  if (resp!.statusCode === 401) {
    output(
      { success: false, reason: "token 无效（HTTP 401），请重新获取" },
      1
    );
  }

  const body = resp!.body;
  if (typeof body !== "object" || body === null) {
    output(
      {
        success: false,
        reason: `响应解析失败 (HTTP ${resp!.statusCode})`,
        raw: resp!.raw.slice(0, 500),
      },
      1
    );
  }
  if (body.code !== 200 || body.success !== true) {
    output(
      {
        success: false,
        reason: body.msg ?? `查询失败 (HTTP ${resp!.statusCode})`,
      },
      1
    );
  }

  const records: any[] = Array.isArray(body.data) ? body.data : [];

  output(
    {
      success: true,
      appUk: opts.appUk,
      env: opts.env,
      count: records.length,
      records,
    },
    0
  );
}

main();
