/**
 * update-load-state.ts
 *
 * 修改应用指定实例的负载状态（Naming / Furt EditAppState）。
 * 对应 Jean API：POST /api/load/state
 *
 * 用法：
 *   node --experimental-strip-types scripts/update-load-state.ts \
 *     --appUk <appUk> \
 *     --env   <env> \
 *     --state <auto|enable|disable> \
 *     --instances <id1,id2,...> \
 *     [--areaId <n>] \
 *     [--businessId <n>] \
 *     [--token <jean-token>]
 *
 * 说明：
 *   - --instances 为实例 **id**（与 instance-list.ts / 部署 clients 同源），逗号分隔
 *   - --areaId / --businessId 可选；优先从 instance-list.ts 选中实例的 areaId/businessId 传入
 *     （多区域/多业务域应用强烈建议传入）；未传时由服务端按应用配置自动解析
 *   - 不拦截 product 环境；是否允许操作由服务端 Matrix 白名单决定
 *
 * 输出（JSON）：
 *   成功：{ success: true, appUk, env, state, instanceIds, areaId?, businessId?, message }
 *   失败：{ success: false, reason: "..." }
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const SKILL_DIR = path.resolve(import.meta.dirname, "..");
const TOKEN_PATH = path.join(SKILL_DIR, "assets", "jean-token");
const API_URL =
  process.env.JEAN_LOAD_STATE_API ?? "http://jean.17usoft.com/api/load/state";
const REQUEST_TIMEOUT = 30_000;
const VALID_STATES = new Set(["auto", "enable", "disable"]);

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
  state: string;
  instanceIds: string[];
  areaId?: number;
  businessId?: number;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = {
    token: "",
    appUk: "",
    env: "",
    state: "",
    instanceIds: [],
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--token":
        opts.token = args[++i] ?? "";
        break;
      case "--appUk":
        opts.appUk = args[++i] ?? "";
        break;
      case "--env":
        opts.env = args[++i] ?? "";
        break;
      case "--state":
        opts.state = args[++i] ?? "";
        break;
      case "--instances": {
        const raw = args[++i] ?? "";
        opts.instanceIds = raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      }
      case "--areaId": {
        const n = parseInt(args[++i] ?? "", 10);
        if (!Number.isInteger(n) || n <= 0) {
          output({ success: false, reason: "areaId 必须为正整数" }, 1);
        }
        opts.areaId = n;
        break;
      }
      case "--businessId": {
        const n = parseInt(args[++i] ?? "", 10);
        if (!Number.isInteger(n) || n <= 0) {
          output({ success: false, reason: "businessId 必须为正整数" }, 1);
        }
        opts.businessId = n;
        break;
      }
      default:
        output({ success: false, reason: `未知参数: ${args[i]}` }, 1);
    }
  }

  if (!opts.token) {
    try {
      opts.token = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
    } catch {
      // ignore
    }
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

  opts.appUk = opts.appUk.trim();
  opts.env = opts.env.trim();
  opts.state = opts.state.trim();

  if (!opts.appUk || !opts.env || !opts.state) {
    output(
      {
        success: false,
        reason: "缺少必填参数: --appUk, --env, --state, --instances",
      },
      1
    );
  }
  if (!VALID_STATES.has(opts.state)) {
    output(
      {
        success: false,
        reason: "state 只能是: auto, enable, disable",
      },
      1
    );
  }

  // 去重（与服务端 normalize 行为对齐）
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of opts.instanceIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  opts.instanceIds = deduped;

  if (opts.instanceIds.length === 0) {
    output(
      {
        success: false,
        reason: "实例列表为空：请通过 --instances 传入至少一个实例 id",
      },
      1
    );
  }

  return opts;
}

/* ---------- main ---------- */

async function main() {
  const opts = parseArgs();

  const payload: Record<string, unknown> = {
    appUk: opts.appUk,
    env: opts.env,
    state: opts.state,
    instanceIds: opts.instanceIds,
  };
  if (opts.areaId !== undefined) {
    payload.areaId = opts.areaId;
  }
  if (opts.businessId !== undefined) {
    payload.businessId = opts.businessId;
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

  // 参数绑定失败时 handler 可能返回 HTTP 400
  if (resp!.statusCode === 400) {
    const body = resp!.body;
    const msg =
      typeof body === "object" && body !== null
        ? (body.msg ?? body.message ?? JSON.stringify(body))
        : String(body).slice(0, 500);
    output(
      {
        success: false,
        reason: `参数错误 (HTTP 400): ${msg}`,
      },
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

  // Jean 标准响应：code===200 且 success===true；失败多为 code 500 / success false
  if (body.success === false || body.code === 500 || resp!.statusCode !== 200) {
    output(
      {
        success: false,
        reason:
          body.msg ??
          body.message ??
          `修改负载状态失败 (HTTP ${resp!.statusCode})`,
      },
      1
    );
  }
  if (body.code !== undefined && body.code !== 200) {
    output(
      {
        success: false,
        reason:
          body.msg ??
          body.message ??
          `修改负载状态失败 (code=${body.code})`,
      },
      1
    );
  }

  const result: Record<string, unknown> = {
    success: true,
    appUk: opts.appUk,
    env: opts.env,
    state: opts.state,
    instanceIds: opts.instanceIds,
    instanceCount: opts.instanceIds.length,
    message: `已将 ${opts.instanceIds.length} 个实例的负载状态修改为 ${opts.state}`,
  };
  if (opts.areaId !== undefined) result.areaId = opts.areaId;
  if (opts.businessId !== undefined) result.businessId = opts.businessId;

  output(result, 0);
}

main();
