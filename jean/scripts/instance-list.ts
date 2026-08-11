/**
 * instance-list.ts
 *
 * 列出 appUk 在指定 env 下当前的所有实例（id + ip + areaId + businessId）。
 * 返回的 id 列表与部署接口（/mcp/deploy）在 clients 为空时使用的同一组 ID，
 * 因此从此列表中挑选的 id 可直接传回 build-deploy.ts 的 --instances。
 * ip 仅用于让用户按 IP 选择实例：拿到用户指定的 IP 后映射到对应 id 再部署。
 * areaId / businessId 用于负载状态变更（update-load-state.ts）等多区域场景。
 *
 * 接口：GET /api/mcp/instances/detail
 * 对应 jean.api InstanceInfo：{ id, ip, areaId, businessId }
 * 解析器同时兼容老接口的 string[] 形态（此时 ip/areaId/businessId 为 null），便于灰度切换。
 *
 * 用法：
 *   node --experimental-strip-types scripts/instance-list.ts \
 *     --appUk <appUk> \
 *     --env   <env> \
 *     [--token <jean-token>]
 *
 * 输出（JSON）：
 *   成功（退出码 0）：
 *   {
 *     "success": true,
 *     "appUk": "...",
 *     "env": "...",
 *     "count": N,
 *     "instances": [
 *       { "id": "id1", "ip": "10.0.0.1", "areaId": 1, "businessId": 1 },
 *       ...
 *     ],
 *     "ids": ["id1", "id2", ...]   // 便于直接拼接 --instances
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
// 默认走生产；可用 JEAN_INSTANCES_API 覆盖（联调预发 / 切环境用），生产默认值保持不变
const API_BASE =
  process.env.JEAN_INSTANCES_API ??
  "http://jean.17usoft.com/api/mcp/instances/detail";

/* ---------- helpers ---------- */

interface InstanceRow {
  id: string;
  ip: string | null;
  areaId: number | null;
  businessId: number | null;
}

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

/** 解析接口返回的 areaId / businessId；缺省或非法时为 null（老接口兼容） */
function parseOptionalInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return null;
    const n = Number.parseInt(s, 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/* ---------- parse args ---------- */

function parseArgs(): { appUk?: string; env?: string; token?: string } {
  const args = process.argv.slice(2);
  const result: { appUk?: string; env?: string; token?: string } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--appUk" && args[i + 1]) {
      result.appUk = args[++i];
    } else if (args[i] === "--env" && args[i + 1]) {
      result.env = args[++i];
    } else if (args[i] === "--token" && args[i + 1]) {
      result.token = args[++i];
    }
  }
  return result;
}

/* ---------- main ---------- */

async function main() {
  const opts = parseArgs();

  if (!opts.appUk || !opts.env) {
    output(
      {
        success: false,
        reason: "缺少必填参数: --appUk, --env",
      },
      1
    );
  }

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

  const url = `${API_BASE}?appUk=${encodeURIComponent(opts.appUk!)}&env=${encodeURIComponent(opts.env!)}`;

  try {
    const { statusCode, body } = await httpGetJson(url, {
      "jean-token": token!,
    });

    if (statusCode === 401) {
      output({ success: false, reason: "token 无效（HTTP 401），请重新获取" }, 1);
    }

    if (statusCode !== 200) {
      const msg =
        typeof body === "object"
          ? body?.msg ?? body?.message ?? JSON.stringify(body)
          : String(body).slice(0, 500);
      output(
        {
          success: false,
          reason: `查询实例失败 (HTTP ${statusCode}): ${msg}`,
        },
        1
      );
    }

    // 兼容两种返回形态：
    //   新接口 /detail → data: [{ id, ip, areaId, businessId }]
    //   老接口          → data: string[]（或裸 string[]），此时 ip/areaId/businessId 置 null
    const rawList: unknown[] = Array.isArray(body)
      ? body
      : Array.isArray(body?.data)
        ? body.data
        : [];

    const instances: InstanceRow[] = rawList
      .map((item): InstanceRow | null => {
        if (typeof item === "string") {
          return { id: item, ip: null, areaId: null, businessId: null };
        }
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          if (typeof o.id === "string") {
            return {
              id: o.id,
              ip: typeof o.ip === "string" ? o.ip : null,
              areaId: parseOptionalInt(o.areaId),
              businessId: parseOptionalInt(o.businessId),
            };
          }
        }
        return null;
      })
      .filter((x): x is InstanceRow => x !== null);

    output(
      {
        success: true,
        appUk: opts.appUk!,
        env: opts.env!,
        count: instances.length,
        instances,
        ids: instances.map((i) => i.id),
      },
      0
    );
  } catch (err: any) {
    output({ success: false, reason: `请求失败: ${err.message}` }, 1);
  }
}

main();
