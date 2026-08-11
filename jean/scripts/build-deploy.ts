/**
 * build-deploy.ts
 *
 * 完整的 构建 → 轮询 → 部署 → 轮询 自动化流程
 * 将多步 API 调用、轮询逻辑、超时控制、错误处理封装为确定性脚本
 * Agent 只需传参调用，无需自行管理状态
 *
 * 用法:
 *   node --experimental-strip-types scripts/build-deploy.ts \
 *     --token  <jean-token> \
 *     --appUk  <appUk> \
 *     --env    <env> \
 *     --buildType <branch|tag> \
 *     --branchTag <branch-or-tag-name> \
 *     [--buildVersion <version>] \
 *     [--deploy-version <specific-image-version>] \
 *     [--build-only]        # 仅构建，不部署
 *     [--deploy-only]       # 仅部署（跳过构建）
 *
 * 输出: JSON 格式的结果（stdout），方便 Agent 解析
 * {
 *   "success": true/false,
 *   "stage": "build"|"deploy",
 *   "message": "人类可读的结果描述",
 *   "details": { ... }
 * }
 *
 * 进度日志输出到 stderr，不影响 JSON 解析。
 */

import http from "node:http";

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
  appUk: string;
  env: string;
  buildType: string;
  branchTag: string;
  buildVersion: string;
  deployVersion: string;
  buildOnly: boolean;
  deployOnly: boolean;
  instances: string[];
}

// ============================================================
// 常量
// ============================================================

const BASE_URL = "http://jean.17usoft.com/api";
const REQUEST_TIMEOUT = 30_000;
const POLL_INTERVAL = 15_000;
const BUILD_MAX_POLLS = 30;
const DEPLOY_MAX_POLLS = 20;

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
  token: string,
  body?: string
): Promise<{ statusCode: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers: Record<string, string> = { "jean-token": token };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
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

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

async function apiGet(
  path: string,
  token: string
): Promise<{ statusCode: number; body: any; raw: string }> {
  return httpRequest("GET", `${BASE_URL}${path}`, token);
}

async function apiPost(
  path: string,
  token: string,
  data: Record<string, unknown>
): Promise<{ statusCode: number; body: any; raw: string }> {
  return httpRequest("POST", `${BASE_URL}${path}`, token, JSON.stringify(data));
}

// ============================================================
// 参数解析
// ============================================================

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = {
    token: "",
    appUk: "",
    env: "",
    buildType: "branch",
    branchTag: "",
    buildVersion: "",
    deployVersion: "",
    buildOnly: false,
    deployOnly: false,
    instances: [],
  };

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
      case "--buildType":
        opts.buildType = args[++i];
        break;
      case "--branchTag":
        opts.branchTag = args[++i];
        break;
      case "--buildVersion":
        opts.buildVersion = args[++i];
        break;
      case "--deploy-version":
        opts.deployVersion = args[++i];
        break;
      case "--build-only":
        opts.buildOnly = true;
        break;
      case "--deploy-only":
        opts.deployOnly = true;
        break;
      case "--instances":
        opts.instances = args[++i]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      default:
        log(`未知参数: ${args[i]}`);
        process.exit(1);
    }
  }

  return opts;
}

function validate(opts: Options): void {
  if (!opts.token || !opts.appUk) {
    outputResult({
      success: false,
      stage: "init",
      message: "缺少必填参数: --token, --appUk",
      details: {},
    });
  }

  // env: 仅 --build-only 通用环境构建可省略；涉及部署时必填
  if (!opts.buildOnly && !opts.env) {
    outputResult({
      success: false,
      stage: "init",
      message: "缺少必填参数: --env（仅 --build-only 通用环境构建可省略 env）",
      details: {},
    });
  }

  if (opts.env && opts.env.startsWith("product")) {
    outputResult({
      success: false,
      stage: "init",
      message: "安全限制: 不允许对生产环境执行此操作",
      details: {},
    });
  }

  if (!opts.deployOnly && !opts.branchTag) {
    outputResult({
      success: false,
      stage: "init",
      message: "构建需要指定 --branchTag",
      details: {},
    });
  }
}

// ============================================================
// Step 1: 触发构建
// ============================================================

interface BuildInfo {
  recordId: string;
  version: string;
}

async function triggerBuild(opts: Options): Promise<BuildInfo> {
  const envLabel = opts.env || "(通用环境)";
  log(
    `>>> [构建] 触发构建: appUk=${opts.appUk}, env=${envLabel}, ${opts.buildType}=${opts.branchTag}`
  );

  const body: Record<string, unknown> = {
    appUk: opts.appUk,
    env: opts.env,
    buildType: opts.buildType,
    branchTag: opts.branchTag,
  };
  if (opts.buildVersion) {
    body.buildVersion = opts.buildVersion;
  }

  let resp;
  try {
    resp = await apiPost("/build/ci/execute/mcp", opts.token, body);
  } catch (err: any) {
    outputResult({
      success: false,
      stage: "build",
      message: `构建触发失败，API 请求异常: ${err.message}`,
      details: { error: "request_failed" },
    });
  }

  // API 响应结构为 {code, data: {recordId, version}, msg, success}
  const data = resp!.body?.data ?? resp!.body;
  const recordId = data?.recordId ?? "";
  const version = data?.version ?? "";

  if (!recordId) {
    outputResult({
      success: false,
      stage: "build",
      message: "构建触发失败，未返回 recordId",
      details: { response: resp!.raw.slice(0, 500) },
    });
  }

  log(`>>> [构建] 已触发，recordId=${recordId}, version=${version}`);
  return { recordId, version };
}

// ============================================================
// Step 2: 轮询构建状态
// ============================================================

async function pollBuild(opts: Options, build: BuildInfo): Promise<void> {
  log(
    `>>> [构建] 开始轮询状态 (最多 ${BUILD_MAX_POLLS} 次, 间隔 ${POLL_INTERVAL / 1000}s)...`
  );

  for (let i = 1; i <= BUILD_MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL);
    const elapsed = i * (POLL_INTERVAL / 1000);

    let resp;
    try {
      resp = await apiGet(
        `/build/ci/status/mcp?appUk=${opts.appUk}&version=${build.version}`,
        opts.token
      );
    } catch {
      log(`>>> [构建] 第 ${i} 次轮询请求失败，继续重试...`);
      continue;
    }

    // 兼容 {code, data: {status}, ...} 和直接 {status} 两种响应格式
    const statusData = resp.body?.data ?? resp.body;
    const status = statusData?.status;

    switch (status) {
      case 1:
        log(`>>> [构建] 排队中... (${elapsed}s)`);
        break;
      case 2:
        log(`>>> [构建] 构建中... (${elapsed}s)`);
        break;
      case 3:
        log(`>>> [构建] 构建成功! (耗时 ${elapsed}s)`);
        return; // 成功，继续后续流程
      case 4:
        log(`>>> [构建] 构建失败，正在获取分析...`);
        await getBuildAnalysis(opts, build);
        break; // getBuildAnalysis 内部会 exit
      default:
        log(`>>> [构建] 未知状态: ${status}，继续轮询...`);
    }
  }

  outputResult({
    success: false,
    stage: "build",
    message: `构建超时 (已等待 ${BUILD_MAX_POLLS * (POLL_INTERVAL / 1000)}s)`,
    details: { recordId: build.recordId, version: build.version },
  });
}

// ============================================================
// Step 2a: 构建失败分析
// ============================================================

async function getBuildAnalysis(
  opts: Options,
  build: BuildInfo
): Promise<void> {
  try {
    const resp = await apiGet(
      `/assistant/session?buildId=${build.recordId}`,
      opts.token
    );
    outputResult({
      success: false,
      stage: "build",
      message: "构建失败",
      details: {
        recordId: build.recordId,
        version: build.version,
        analysis: resp.raw.slice(0, 2000),
      },
    });
  } catch {
    outputResult({
      success: false,
      stage: "build",
      message: "构建失败，且无法获取 AI 分析",
      details: { recordId: build.recordId, version: build.version },
    });
  }
}

// ============================================================
// Step 3: 触发部署
// ============================================================

async function triggerDeploy(opts: Options): Promise<void> {
  const body: Record<string, unknown> = {
    appUk: opts.appUk,
    env: opts.env,
  };

  // 仅当显式指定 --deploy-version 时才传 version，默认不传
  if (opts.deployVersion) {
    body.version = opts.deployVersion;
  }

  // 仅当显式指定 --instances 时才传 clients，默认不传 = 部署全部实例
  if (opts.instances.length > 0) {
    body.clients = opts.instances;
  }

  const summary = [
    `appUk=${opts.appUk}`,
    `env=${opts.env}`,
    opts.deployVersion ? `version=${opts.deployVersion}` : "使用最新构建镜像",
    opts.instances.length > 0
      ? `instances=[${opts.instances.join(",")}]`
      : "全部实例",
  ].join(", ");
  log(`>>> [部署] 触发部署: ${summary}`);

  try {
    await apiPost("/mcp/deploy", opts.token, body);
  } catch (err: any) {
    outputResult({
      success: false,
      stage: "deploy",
      message: `部署触发失败，API 请求异常: ${err.message}`,
      details: { error: "request_failed" },
    });
  }

  log(`>>> [部署] 已触发，开始轮询部署状态...`);
}

// ============================================================
// Step 4: 轮询部署状态
// ============================================================

async function pollDeploy(opts: Options): Promise<void> {
  for (let i = 1; i <= DEPLOY_MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL);
    const elapsed = i * (POLL_INTERVAL / 1000);

    let resp;
    try {
      resp = await apiGet(
        `/mcp/deploy/status?appUk=${opts.appUk}&env=${opts.env}`,
        opts.token
      );
    } catch {
      log(`>>> [部署] 第 ${i} 次轮询请求失败，继续重试...`);
      continue;
    }

    // 兼容响应为数组或对象的情况
    const firstRecord = Array.isArray(resp.body)
      ? resp.body[0]
      : resp.body?.data?.[0] ?? resp.body;

    const status = firstRecord?.status ?? "";
    const opId = firstRecord?.opId ?? "";

    switch (status) {
      case "deploying":
        log(`>>> [部署] 部署中... (${elapsed}s)`);
        break;
      case "success":
        log(`>>> [部署] 部署成功! (耗时 ${elapsed}s)`);
        outputResult({
          success: true,
          stage: "deploy",
          message: `部署成功！${opts.appUk} 已发布到 ${opts.env}`,
          details: { appUk: opts.appUk, env: opts.env },
        });
        break; // outputResult 会 exit
      case "failed":
      case "stop":
        log(`>>> [部署] 部署失败(${status})，正在获取日志...`);
        await getDeployLogs(opts, opId);
        break; // getDeployLogs 内部会 exit
      default:
        log(`>>> [部署] 未知状态: ${status}，继续轮询...`);
    }
  }

  outputResult({
    success: false,
    stage: "deploy",
    message: `部署超时 (已等待 ${DEPLOY_MAX_POLLS * (POLL_INTERVAL / 1000)}s)`,
    details: { appUk: opts.appUk, env: opts.env },
  });
}

// ============================================================
// Step 4a: 部署失败日志
// ============================================================

async function getDeployLogs(opts: Options, opId: string): Promise<void> {
  try {
    const resp = await apiGet(
      `/mcp/deploy/logs?appUk=${opts.appUk}&opId=${opId}`,
      opts.token
    );
    outputResult({
      success: false,
      stage: "deploy",
      message: "部署失败",
      details: { opId, logs: resp.raw.slice(0, 3000) },
    });
  } catch {
    outputResult({
      success: false,
      stage: "deploy",
      message: "部署失败，且无法获取日志",
      details: { opId },
    });
  }
}

// ============================================================
// 主流程
// ============================================================

async function main(): Promise<void> {
  const opts = parseArgs();
  validate(opts);

  if (opts.deployOnly) {
    // 仅部署
    await triggerDeploy(opts);
    await pollDeploy(opts);
  } else if (opts.buildOnly) {
    // 仅构建
    const build = await triggerBuild(opts);
    await pollBuild(opts, build);
    outputResult({
      success: true,
      stage: "build",
      message: `构建成功，版本: ${build.version}`,
      details: { recordId: build.recordId, version: build.version },
    });
  } else {
    // 完整流程: 构建 → 部署
    const build = await triggerBuild(opts);
    await pollBuild(opts, build);
    await triggerDeploy(opts);
    await pollDeploy(opts);
  }
}

main().catch((err) => {
  outputResult({
    success: false,
    stage: "unknown",
    message: `未预期的错误: ${err.message}`,
    details: { stack: err.stack },
  });
});
