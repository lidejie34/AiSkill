/**
 * pipeline-executions.ts
 *
 * 查看流水线执行记录
 *
 * 用法:
 *   node --experimental-strip-types scripts/pipeline-executions.ts \
 *     --pipelineId <id> \
 *     [--token <token>] \
 *     [--page <n>] \
 *     [--pageSize <n>]
 *
 * 输出: JSON（stdout）
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const SKILL_DIR = path.resolve(import.meta.dirname, "..");
const TOKEN_PATH = path.join(SKILL_DIR, "assets", "jean-token");
const BASE_URL = "http://matrix.17usoft.com/pipeline/api";
const REQUEST_TIMEOUT = 30_000;

function output(obj: Record<string, unknown>, exitCode: number): never {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(exitCode);
}

function httpGet(
  url: string,
  token: string
): Promise<{ statusCode: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: { mptoken: token },
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let parsed: any;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ statusCode: res.statusCode ?? 0, body: parsed, raw });
      });
    });

    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy();
      reject(new Error("请求超时"));
    });
    req.end();
  });
}

interface Options {
  token: string;
  pipelineId: string;
  page: number;
  pageSize: number;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = { token: "", pipelineId: "", page: 1, pageSize: 10 };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--token":
        opts.token = args[++i];
        break;
      case "--pipelineId":
        opts.pipelineId = args[++i];
        break;
      case "--page":
        opts.page = parseInt(args[++i], 10);
        break;
      case "--pageSize":
        opts.pageSize = parseInt(args[++i], 10);
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
    output({ success: false, reason: "未找到 token，请通过 --token 参数传入或先执行 validate-token.ts" }, 1);
  }
  if (!opts.pipelineId) {
    output({ success: false, reason: "缺少必填参数 --pipelineId" }, 1);
  }

  return opts;
}

async function main() {
  const opts = parseArgs();

  const url = `${BASE_URL}/pipeline-execution?pipelineId=${opts.pipelineId}&page=${opts.page}&pageSize=${opts.pageSize}`;

  let resp;
  try {
    resp = await httpGet(url, opts.token);
  } catch (err: any) {
    output({ success: false, reason: `请求失败: ${err.message}` }, 1);
  }

  if (resp!.statusCode === 401) {
    output({ success: false, reason: "token 无效（HTTP 401），请重新获取" }, 1);
  }

  const body = resp!.body;
  if (body?.code !== 200) {
    output({ success: false, reason: body?.message ?? "查询失败", raw: resp!.raw.slice(0, 500) }, 1);
  }

  const rawList: any[] = Array.isArray(body.data) ? body.data : [];

  const executions = rawList.map((e: any) => ({
    id: e.id,
    pipelineId: e.pipelineId,
    triggerMode: e.triggerMode,
    triggerPerson: e.triggerPerson,
    remark: e.remark,
    status: e.status,
    subStatus: e.subStatus || undefined,
    subStatusText: e.subStatusText || undefined,
    startTime: e.startTime,
    endTime: e.endTime,
    nodes: (e.nodes ?? []).map((n: any) => ({
      stageName: n.stageName,
      status: n.status,
      startTime: n.startTime,
      endTime: n.endTime,
    })),
  }));

  output(
    {
      success: true,
      total: body.total ?? executions.length,
      page: body.page ?? opts.page,
      pageSize: body.size ?? opts.pageSize,
      executions,
    },
    0
  );
}

main();
