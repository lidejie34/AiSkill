/**
 * pipeline-run.ts
 *
 * 触发流水线执行并轮询执行结果
 *
 * 流程：
 *   1. 读取 token（缓存或 --token 参数）
 *   2. 调用 tccommon getuserinfo 接口（multipart/form-data）获取 username + workId
 *      构造 triggerPerson = `${username}(${workId})`
 *   3. 调用 /pipeline-execution 取最近一次执行记录，从中读取 bindApps
 *      （若为空则回退 GET /pipeline/{id} 的 appUks）
 *   4. 用 --branch / --env / --instances 覆盖默认值，构造 executeInfos
 *      （--instances 映射为 executeInfos[].triggerClients，对应 matrix 指定部署客户端）
 *   5. POST /pipeline/{pipelineId}/api-run 触发执行
 *   6. 每 15s 轮询 /pipeline-execution 最新一条记录的 status
 *
 * 用法:
 *   node --experimental-strip-types scripts/pipeline-run.ts \
 *     --pipelineId <id> \
 *     [--token <token>] \
 *     [--branch <branch>] \
 *     [--env <env>] \
 *     [--instances <id1,id2>]   # 可选：指定部署实例 id（灰度），不传=全部实例
 *
 * 输出: JSON（stdout），结构与 build-deploy.ts 的 Result 一致
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ============================================================
// 类型
// ============================================================

interface Result {
  success: boolean;
  stage: string;
  message: string;
  details: Record<string, unknown>;
}

interface Options {
  token: string;
  pipelineId: string;
  branch: string;
  env: string;
  /** 指定部署的实例 id 列表；空 = 全部实例。对应 api-run 的 triggerClients */
  instances: string[];
}

interface BindApp {
  appUk: string;
  gitBranch?: string;
  env?: string;
}

interface ExecuteInfo {
  appUk: string;
  triggerBranch: string;
  triggerEnv: string;
  /** 指定需要部署的客户端（实例 id）；不传或空数组 = 全部实例 */
  triggerClients?: string[];
}

// ============================================================
// 常量
// ============================================================

const SKILL_DIR = path.resolve(import.meta.dirname, "..");
const TOKEN_PATH = path.join(SKILL_DIR, "assets", "jean-token");
const PIPELINE_BASE = "http://matrix.17usoft.com/pipeline/api";
const USER_INFO_URL = "http://tccommon.17usoft.com/oauth/rs/getuserinfo";
const REQUEST_TIMEOUT = 30_000;
const POLL_INTERVAL = 15_000;
const MAX_POLLS = 30; // ≈7.5 分钟

// ============================================================
// 工具函数
// ============================================================

function log(msg: string): void {
  process.stderr.write(msg + "\n");
}

function outputResult(result: Result): never {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.success ? 0 : 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpRequest(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  body?: Buffer | string
): Promise<{ statusCode: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let parsedBody: any;
        try {
          parsedBody = JSON.parse(raw);
        } catch {
          parsedBody = raw;
        }
        resolve({ statusCode: res.statusCode ?? 0, body: parsedBody, raw });
      });
    });

    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy();
      reject(new Error("请求超时"));
    });

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

async function pipelineGet(
  pathPart: string,
  token: string
): Promise<{ statusCode: number; body: any; raw: string }> {
  return httpRequest("GET", `${PIPELINE_BASE}${pathPart}`, { mptoken: token });
}

async function pipelinePost(
  pathPart: string,
  token: string,
  data: Record<string, unknown>
): Promise<{ statusCode: number; body: any; raw: string }> {
  const body = JSON.stringify(data);
  return httpRequest(
    "POST",
    `${PIPELINE_BASE}${pathPart}`,
    {
      mptoken: token,
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body
  );
}

// ============================================================
// 参数解析
// ============================================================

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = {
    token: "",
    pipelineId: "",
    branch: "",
    env: "",
    instances: [],
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--token":
        opts.token = args[++i];
        break;
      case "--pipelineId":
        opts.pipelineId = args[++i];
        break;
      case "--branch":
        opts.branch = args[++i];
        break;
      case "--env":
        opts.env = args[++i];
        break;
      case "--instances":
        opts.instances = (args[++i] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      default:
        outputResult({
          success: false,
          stage: "init",
          message: `未知参数: ${args[i]}`,
          details: {},
        });
    }
  }

  if (!opts.token) {
    try {
      opts.token = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
    } catch {}
  }
  if (!opts.token) {
    outputResult({
      success: false,
      stage: "init",
      message: "未找到 token，请通过 --token 参数传入或先执行 validate-token.ts",
      details: {},
    });
  }
  if (!opts.pipelineId) {
    outputResult({
      success: false,
      stage: "init",
      message: "缺少必填参数 --pipelineId",
      details: {},
    });
  }
  // 流水线执行不拦截 product：是否允许发生产由流水线服务端白名单校验

  return opts;
}

// ============================================================
// Step 1: 获取 triggerPerson（用户信息）
// ============================================================

function buildMultipartBody(
  fields: Record<string, string>
): { body: Buffer; boundary: string } {
  const boundary =
    "----JeanSkillBoundary" + crypto.randomBytes(8).toString("hex");
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(
      Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`)
    );
    parts.push(Buffer.from(value));
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

async function fetchTriggerPerson(token: string): Promise<string> {
  log(`>>> [用户信息] 调用 getuserinfo 获取 triggerPerson...`);

  const { body, boundary } = buildMultipartBody({ access_token: token });
  let resp;
  try {
    resp = await httpRequest(
      "POST",
      USER_INFO_URL,
      {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      body
    );
  } catch (err: any) {
    outputResult({
      success: false,
      stage: "userinfo",
      message: `获取用户信息失败: ${err.message}`,
      details: { error: "request_failed" },
    });
  }

  // 期望响应包含 username 与 workId（具体字段名以实际接口为准）
  // 兼容 { code, data: {...}, ... } 与扁平结构
  const data = resp!.body?.data ?? resp!.body ?? {};
  const username =
    data.username ?? data.userName ?? data.name ?? data.user?.name ?? "";
  const workId =
    data.workId ?? data.work_id ?? data.empId ?? data.user?.workId ?? "";

  if (!username || !workId) {
    outputResult({
      success: false,
      stage: "userinfo",
      message: "无法从 getuserinfo 响应中解析 username/workId",
      details: { response: resp!.raw.slice(0, 500) },
    });
  }

  const triggerPerson = `${username}(${workId})`;
  log(`>>> [用户信息] triggerPerson=${triggerPerson}`);
  return triggerPerson;
}

// ============================================================
// Step 2: 获取流水线 bindApps（从最近一次执行记录中读取）
// ============================================================

async function fetchBindApps(opts: Options): Promise<BindApp[]> {
  log(`>>> [流水线] 查询最近执行记录以获取 bindApps...`);

  let resp;
  try {
    resp = await pipelineGet(
      `/pipeline-execution?pipelineId=${opts.pipelineId}&page=1&pageSize=1`,
      opts.token
    );
  } catch (err: any) {
    outputResult({
      success: false,
      stage: "trigger",
      message: `查询流水线信息失败: ${err.message}`,
      details: { error: "request_failed" },
    });
  }

  if (resp!.statusCode === 401) {
    outputResult({
      success: false,
      stage: "trigger",
      message: "token 无效（HTTP 401），请重新获取",
      details: {},
    });
  }

  const list: any[] = Array.isArray(resp!.body?.data) ? resp!.body.data : [];
  const latest = list[0];

  // 兼容三种来源：
  //   1) latest.bindApps（部分接口直接提供）
  //   2) latest.nodes[].additionalInformation.buildResult（实测的实际来源）
  //   3) GET /pipeline/{id} 的 appUks（无执行记录 / bindApps 为空时回退）
  const bindApps: BindApp[] = [];
  if (Array.isArray(latest?.bindApps) && latest.bindApps.length > 0) {
    bindApps.push(...latest.bindApps);
  } else if (Array.isArray(latest?.nodes)) {
    const seen = new Set<string>();
    for (const n of latest.nodes) {
      const br = n?.additionalInformation?.buildResult;
      if (!br?.appUk || seen.has(br.appUk)) continue;
      seen.add(br.appUk);
      bindApps.push({
        appUk: br.appUk,
        gitBranch: br.branch ?? br.gitBranch ?? "",
        env: br.env ?? "",
      });
    }
  }

  if (bindApps.length === 0) {
    log(
      `>>> [流水线] 执行记录中无 bindApps，回退查询流水线详情 appUks (pipelineId=${opts.pipelineId})...`
    );
    let detailResp;
    try {
      detailResp = await pipelineGet(`/pipeline/${opts.pipelineId}`, opts.token);
    } catch (err: any) {
      outputResult({
        success: false,
        stage: "trigger",
        message: `查询流水线详情失败: ${err.message}`,
        details: { error: "request_failed" },
      });
    }
    if (detailResp!.statusCode === 401) {
      outputResult({
        success: false,
        stage: "trigger",
        message: "token 无效（HTTP 401），请重新获取",
        details: {},
      });
    }
    const appUks: unknown = detailResp!.body?.data?.appUks;
    if (Array.isArray(appUks) && appUks.length > 0) {
      for (const uk of appUks) {
        if (typeof uk === "string" && uk.trim()) {
          bindApps.push({ appUk: uk.trim(), gitBranch: "", env: "" });
        }
      }
      log(
        `>>> [流水线] 从流水线详情得到 appUks=[${bindApps.map((a) => a.appUk).join(",")}]，请确保已传 --branch / --env`
      );
    }
  }

  if (bindApps.length === 0) {
    outputResult({
      success: false,
      stage: "trigger",
      message:
        "无法获取流水线绑定应用（bindApps / appUks 均为空），请确认 pipelineId 正确",
      details: { pipelineId: opts.pipelineId, response: resp!.raw.slice(0, 500) },
    });
  }

  return bindApps;
}

function buildExecuteInfos(opts: Options, bindApps: BindApp[]): ExecuteInfo[] {
  return bindApps.map((app) => {
    const triggerBranch = opts.branch || app.gitBranch || "";
    const triggerEnv = opts.env || app.env || "";
    if (!triggerBranch || !triggerEnv) {
      outputResult({
        success: false,
        stage: "trigger",
        message: `应用 ${app.appUk} 缺少 triggerBranch 或 triggerEnv，请通过 --branch / --env 显式指定`,
        details: { appUk: app.appUk, triggerBranch, triggerEnv },
      });
    }
    // 允许 product：服务端白名单负责校验，skill 侧不拦截
    const info: ExecuteInfo = {
      appUk: app.appUk,
      triggerBranch,
      triggerEnv,
    };
    // 仅当显式指定 --instances 时才传 triggerClients，默认不传 = 部署全部实例
    // 与 Jean /mcp/deploy 的 clients 语义一致；matrix-pipeline-server 字段名为 triggerClients
    if (opts.instances.length > 0) {
      info.triggerClients = opts.instances;
    }
    return info;
  });
}

// ============================================================
// Step 3: 触发流水线执行
// ============================================================

async function triggerPipeline(
  opts: Options,
  triggerPerson: string,
  executeInfos: ExecuteInfo[]
): Promise<string> {
  const instanceHint =
    opts.instances.length > 0
      ? `instances=[${opts.instances.join(",")}]`
      : "全部实例";
  log(
    `>>> [触发] pipelineId=${opts.pipelineId}, ${instanceHint}, executeInfos=${JSON.stringify(executeInfos)}`
  );

  let resp;
  try {
    resp = await pipelinePost(
      `/pipeline/${opts.pipelineId}/api-run`,
      opts.token,
      { triggerPerson, executeInfos }
    );
  } catch (err: any) {
    outputResult({
      success: false,
      stage: "trigger",
      message: `触发流水线失败: ${err.message}`,
      details: { error: "request_failed" },
    });
  }

  if (resp!.statusCode === 401) {
    outputResult({
      success: false,
      stage: "trigger",
      message: "token 无效（HTTP 401），请重新获取",
      details: {},
    });
  }

  const body = resp!.body;
  if (body?.code !== 200) {
    outputResult({
      success: false,
      stage: "trigger",
      message: body?.message ?? body?.msg ?? "触发流水线失败",
      details: { response: resp!.raw.slice(0, 500) },
    });
  }

  const data = body?.data ?? {};
  const executionId = String(data.id ?? data.executionId ?? "");
  log(`>>> [触发] 已触发，executionId=${executionId || "(未返回)"}`);
  return executionId;
}

// ============================================================
// Step 4: 轮询执行状态
// ============================================================

async function pollExecution(opts: Options, executionId: string): Promise<void> {
  log(
    `>>> [轮询] 开始轮询执行状态 (最多 ${MAX_POLLS} 次, 间隔 ${POLL_INTERVAL / 1000}s)...`
  );

  for (let i = 1; i <= MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL);
    const elapsed = i * (POLL_INTERVAL / 1000);

    let resp;
    try {
      resp = await pipelineGet(
        `/pipeline-execution?pipelineId=${opts.pipelineId}&page=1&pageSize=1`,
        opts.token
      );
    } catch {
      log(`>>> [轮询] 第 ${i} 次请求失败，继续重试...`);
      continue;
    }

    const list: any[] = Array.isArray(resp.body?.data) ? resp.body.data : [];
    const latest = list[0];
    const status = latest?.status ?? "";

    // 若拿到 executionId，校验取到的是同一条；未拿到则只能信任最新一条
    if (executionId && latest?.id && String(latest.id) !== executionId) {
      log(`>>> [轮询] 最新记录 id=${latest.id} 与 executionId=${executionId} 不一致，继续轮询...`);
      continue;
    }

    switch (status) {
      case "notStarted":
      case "queuing":
        log(`>>> [轮询] 排队中... (${elapsed}s)`);
        break;
      case "running":
        log(`>>> [轮询] 执行中... (${elapsed}s)`);
        break;
      case "success":
        log(`>>> [轮询] 流水线执行成功! (耗时 ${elapsed}s)`);
        outputResult({
          success: true,
          stage: "poll",
          message: `流水线执行成功 (pipelineId=${opts.pipelineId})`,
          details: {
            pipelineId: opts.pipelineId,
            executionId: latest.id,
            startTime: latest.startTime,
            endTime: latest.endTime,
            nodes: (latest.nodes ?? []).map((n: any) => ({
              stageName: n.stageName,
              status: n.status,
            })),
          },
        });
        break; // outputResult 会 exit
      case "fail":
      case "failed":
      case "aborted":
        log(`>>> [轮询] 流水线执行失败(${status}) (耗时 ${elapsed}s)`);
        outputResult({
          success: false,
          stage: "poll",
          message: `流水线执行${status === "aborted" ? "已中止" : "失败"}`,
          details: {
            pipelineId: opts.pipelineId,
            executionId: latest.id,
            status,
            subStatus: latest.subStatus,
            subStatusText: latest.subStatusText,
            startTime: latest.startTime,
            endTime: latest.endTime,
            nodes: (latest.nodes ?? []).map((n: any) => ({
              stageName: n.stageName,
              status: n.status,
              startTime: n.startTime,
              endTime: n.endTime,
            })),
          },
        });
        break; // outputResult 会 exit
      default:
        log(`>>> [轮询] 未知状态: ${status}，继续轮询...`);
    }
  }

  outputResult({
    success: false,
    stage: "poll",
    message: `流水线执行超时 (已等待 ${MAX_POLLS * (POLL_INTERVAL / 1000)}s)`,
    details: { pipelineId: opts.pipelineId, executionId },
  });
}

// ============================================================
// 主流程
// ============================================================

async function main(): Promise<void> {
  const opts = parseArgs();
  const triggerPerson = await fetchTriggerPerson(opts.token);
  const bindApps = await fetchBindApps(opts);
  const executeInfos = buildExecuteInfos(opts, bindApps);
  const executionId = await triggerPipeline(opts, triggerPerson, executeInfos);
  await pollExecution(opts, executionId);
}

main().catch((err) => {
  outputResult({
    success: false,
    stage: "unknown",
    message: `未预期的错误: ${err.message}`,
    details: { stack: err.stack },
  });
});
