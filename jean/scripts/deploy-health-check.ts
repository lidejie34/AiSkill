/**
 * deploy-health-check.ts
 *
 * 查询应用的部署健康检查 + 负载健康检查配置（聚合接口）。
 * --env 仅本地过滤部署侧配置；接口支持 partial success。
 *
 * 用法：
 *   node --experimental-strip-types scripts/deploy-health-check.ts \
 *     --appUk <appUk> \
 *     [--region <serviceSite>] \
 *     [--env <env>] \
 *     [--token <jean-token>]
 *
 * 成功（退出码 0，含 partial success）：
 *   {
 *     "success": true,
 *     "deploy": {
 *       "configs": [{ "serviceSite", "env", "config" }],
 *       "errors": [{ "serviceSite", "message" }]
 *     },
 *     "loadBalancer": {
 *       "configs": [{ "platform", "upstreamNameOrEnv", "id", "groupId", "groupName", "config" }],
 *       "errors": [{ "source", "message" }]
 *     }
 *   }
 *
 * 失败（退出码 1）：
 *   { "success": false, "reason": "..." }
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const SKILL_DIR = path.resolve(import.meta.dirname, "..");
const TOKEN_PATH = path.join(SKILL_DIR, "assets", "jean-token");
const DEFAULT_API_URL =
  "http://jean.17usoft.com/api/healthcheck/standard/combined-realtime-config";
const API_URL = process.env.JEAN_DEPLOY_HEALTH_CHECK_API ?? DEFAULT_API_URL;
const REQUEST_TIMEOUT = 40_000;

type JsonObject = Record<string, unknown>;

interface Options {
  appUk: string;
  region?: string;
  env?: string;
  token: string;
}

interface NormalizedDeployConfig {
  serviceSite: string;
  env: string;
  config: JsonObject;
}

interface NormalizedDeployError {
  serviceSite: string;
  message: string;
}

interface NormalizedLoadBalancerConfig {
  platform: string;
  upstreamNameOrEnv: string;
  id: string;
  groupId: string;
  groupName: string;
  config: JsonObject;
}

interface NormalizedLoadBalancerError {
  source: string;
  message: string;
}

interface ParsedCombinedRealtimeConfig {
  deploy: {
    configs: NormalizedDeployConfig[];
    errors: NormalizedDeployError[];
  };
  loadBalancer: {
    configs: NormalizedLoadBalancerConfig[];
    errors: NormalizedLoadBalancerError[];
  };
}

function output(obj: JsonObject, exitCode: number): never {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(exitCode);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function responseMessage(body: JsonObject): string | undefined {
  const value = body.msg;
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return undefined;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    output({ success: false, reason: `参数 ${flag} 缺少值` }, 1);
  }
  return value;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = { appUk: "", token: "" };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--appUk":
        opts.appUk = requireValue(args, i, arg).trim();
        i++;
        break;
      case "--region":
        opts.region = requireValue(args, i, arg).trim();
        i++;
        break;
      case "--env":
        opts.env = requireValue(args, i, arg).trim();
        i++;
        break;
      case "--token":
        opts.token = requireValue(args, i, arg).trim();
        i++;
        break;
      default:
        output({ success: false, reason: `未知参数: ${arg}` }, 1);
    }
  }

  if (!opts.appUk) {
    output({ success: false, reason: "缺少必填参数: --appUk" }, 1);
  }

  if (!opts.token) {
    try {
      opts.token = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
    } catch {
      // 统一在下方返回缺少 token 的错误。
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

  return opts;
}

function httpGetJson(
  url: URL,
  headers: Record<string, string>
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const client: typeof http | typeof https =
      url.protocol === "https:" ? https : http;
    const req = client.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        try {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: JSON.parse(raw),
          });
        } catch {
          reject(new Error(`响应不是有效 JSON (HTTP ${res.statusCode ?? 0})`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy();
      reject(new Error("请求超时（40s）"));
    });
  });
}

function parseDeployConfigs(
  items: unknown[],
  envFilter?: string
): NormalizedDeployConfig[] {
  const configs: NormalizedDeployConfig[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!isJsonObject(item)) {
      output(
        {
          success: false,
          reason: `响应格式错误：data.deploy.configs[${i}] 应为对象`,
        },
        1
      );
    }

    const serviceSite = item.serviceSite;
    const env = item.env;
    const config = item.config;
    if (typeof serviceSite !== "string") {
      output(
        {
          success: false,
          reason: `响应格式错误：data.deploy.configs[${i}].serviceSite 应为字符串`,
        },
        1
      );
    }
    if (typeof env !== "string" || env.trim() === "") {
      output(
        {
          success: false,
          reason: `响应格式错误：data.deploy.configs[${i}].env 应为非空字符串`,
        },
        1
      );
    }
    if (!isJsonObject(config)) {
      output(
        {
          success: false,
          reason: `响应格式错误：data.deploy.configs[${i}].config 应为对象`,
        },
        1
      );
    }

    if (!envFilter || env === envFilter) {
      configs.push({ serviceSite, env, config });
    }
  }

  configs.sort((a, b) => {
    const siteOrder = a.serviceSite.localeCompare(b.serviceSite);
    return siteOrder !== 0 ? siteOrder : a.env.localeCompare(b.env);
  });
  return configs;
}

function parseDeployErrors(items: unknown[]): NormalizedDeployError[] {
  const errors: NormalizedDeployError[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!isJsonObject(item)) {
      output(
        {
          success: false,
          reason: `响应格式错误：data.deploy.errors[${i}] 应为对象`,
        },
        1
      );
    }

    const serviceSite = item.serviceSite;
    const message = item.message;
    if (typeof serviceSite !== "string") {
      output(
        {
          success: false,
          reason: `响应格式错误：data.deploy.errors[${i}].serviceSite 应为字符串`,
        },
        1
      );
    }
    if (typeof message !== "string" || message.trim() === "") {
      output(
        {
          success: false,
          reason: `响应格式错误：data.deploy.errors[${i}].message 应为非空字符串`,
        },
        1
      );
    }

    errors.push({ serviceSite, message: message.trim() });
  }

  errors.sort((a, b) => {
    const siteOrder = a.serviceSite.localeCompare(b.serviceSite);
    return siteOrder !== 0 ? siteOrder : a.message.localeCompare(b.message);
  });
  return errors;
}

function parseLoadBalancerConfigs(
  items: unknown[]
): NormalizedLoadBalancerConfig[] {
  const configs: NormalizedLoadBalancerConfig[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!isJsonObject(item)) {
      output(
        {
          success: false,
          reason: `响应格式错误：data.loadBalancer.configs[${i}] 应为对象`,
        },
        1
      );
    }

    const platform = item.platform;
    const upstreamNameOrEnv = item.upstreamNameOrEnv;
    const id = item.id;
    const groupId = item.groupId;
    const groupName = item.groupName;
    const config = item.config;

    if (typeof platform !== "string" || platform.trim() === "") {
      output(
        {
          success: false,
          reason: `响应格式错误：data.loadBalancer.configs[${i}].platform 应为非空字符串`,
        },
        1
      );
    }
    if (
      typeof upstreamNameOrEnv !== "string" ||
      upstreamNameOrEnv.trim() === ""
    ) {
      output(
        {
          success: false,
          reason: `响应格式错误：data.loadBalancer.configs[${i}].upstreamNameOrEnv 应为非空字符串`,
        },
        1
      );
    }
    if (typeof id !== "string") {
      output(
        {
          success: false,
          reason: `响应格式错误：data.loadBalancer.configs[${i}].id 应为字符串`,
        },
        1
      );
    }
    if (typeof groupId !== "string") {
      output(
        {
          success: false,
          reason: `响应格式错误：data.loadBalancer.configs[${i}].groupId 应为字符串`,
        },
        1
      );
    }
    if (typeof groupName !== "string") {
      output(
        {
          success: false,
          reason: `响应格式错误：data.loadBalancer.configs[${i}].groupName 应为字符串`,
        },
        1
      );
    }
    if (!isJsonObject(config)) {
      output(
        {
          success: false,
          reason: `响应格式错误：data.loadBalancer.configs[${i}].config 应为对象`,
        },
        1
      );
    }

    configs.push({
      platform,
      upstreamNameOrEnv,
      id,
      groupId,
      groupName,
      config,
    });
  }

  configs.sort((a, b) => {
    const platformOrder = a.platform.localeCompare(b.platform);
    return platformOrder !== 0
      ? platformOrder
      : a.upstreamNameOrEnv.localeCompare(b.upstreamNameOrEnv);
  });
  return configs;
}

function parseLoadBalancerErrors(
  items: unknown[]
): NormalizedLoadBalancerError[] {
  const errors: NormalizedLoadBalancerError[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!isJsonObject(item)) {
      output(
        {
          success: false,
          reason: `响应格式错误：data.loadBalancer.errors[${i}] 应为对象`,
        },
        1
      );
    }

    const source = item.source;
    const message = item.message;
    if (typeof source !== "string" || source.trim() === "") {
      output(
        {
          success: false,
          reason: `响应格式错误：data.loadBalancer.errors[${i}].source 应为非空字符串`,
        },
        1
      );
    }
    if (typeof message !== "string" || message.trim() === "") {
      output(
        {
          success: false,
          reason: `响应格式错误：data.loadBalancer.errors[${i}].message 应为非空字符串`,
        },
        1
      );
    }

    errors.push({ source, message: message.trim() });
  }

  errors.sort((a, b) => {
    const sourceOrder = a.source.localeCompare(b.source);
    return sourceOrder !== 0
      ? sourceOrder
      : a.message.localeCompare(b.message);
  });
  return errors;
}

function parseCombinedRealtimeConfig(
  body: unknown,
  statusCode: number,
  envFilter?: string
): ParsedCombinedRealtimeConfig {
  if (statusCode === 401) {
    output(
      { success: false, reason: "token 无效（HTTP 401），请重新获取" },
      1
    );
  }

  if (!isJsonObject(body)) {
    output({ success: false, reason: "响应格式错误：期望统一响应对象" }, 1);
  }

  const hasEnvelopeFields =
    typeof body.code === "number" &&
    typeof body.success === "boolean" &&
    Object.hasOwn(body, "msg") &&
    (body.msg === null || typeof body.msg === "string") &&
    Object.hasOwn(body, "data");
  if (!hasEnvelopeFields) {
    output(
      {
        success: false,
        reason: "响应格式错误：期望 code/success/msg/data 统一响应结构",
      },
      1
    );
  }

  if (statusCode !== 200) {
    output(
      {
        success: false,
        reason:
          responseMessage(body) ??
          `查询健康检查配置失败 (HTTP ${statusCode})`,
      },
      1
    );
  }

  if (body.code !== 200 || body.success !== true) {
    output(
      {
        success: false,
        reason: responseMessage(body) ?? "查询健康检查配置失败",
      },
      1
    );
  }

  if (!isJsonObject(body.data)) {
    output(
      {
        success: false,
        reason: "响应格式错误：data 应为对象（含 deploy / loadBalancer）",
      },
      1
    );
  }

  if (!isJsonObject(body.data.deploy)) {
    output(
      { success: false, reason: "响应格式错误：data.deploy 应为对象" },
      1
    );
  }
  if (!isJsonObject(body.data.loadBalancer)) {
    output(
      {
        success: false,
        reason: "响应格式错误：data.loadBalancer 应为对象",
      },
      1
    );
  }

  if (!Array.isArray(body.data.deploy.configs)) {
    output(
      {
        success: false,
        reason: "响应格式错误：data.deploy.configs 应为数组",
      },
      1
    );
  }
  if (!Array.isArray(body.data.deploy.errors)) {
    output(
      {
        success: false,
        reason: "响应格式错误：data.deploy.errors 应为数组",
      },
      1
    );
  }
  if (!Array.isArray(body.data.loadBalancer.configs)) {
    output(
      {
        success: false,
        reason: "响应格式错误：data.loadBalancer.configs 应为数组",
      },
      1
    );
  }
  if (!Array.isArray(body.data.loadBalancer.errors)) {
    output(
      {
        success: false,
        reason: "响应格式错误：data.loadBalancer.errors 应为数组",
      },
      1
    );
  }

  return {
    deploy: {
      configs: parseDeployConfigs(body.data.deploy.configs, envFilter),
      errors: parseDeployErrors(body.data.deploy.errors),
    },
    loadBalancer: {
      configs: parseLoadBalancerConfigs(body.data.loadBalancer.configs),
      errors: parseLoadBalancerErrors(body.data.loadBalancer.errors),
    },
  };
}

async function main() {
  const opts = parseArgs();

  let url: URL;
  try {
    url = new URL(API_URL);
  } catch {
    output(
      { success: false, reason: "JEAN_DEPLOY_HEALTH_CHECK_API 不是有效 URL" },
      1
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    output(
      {
        success: false,
        reason: "JEAN_DEPLOY_HEALTH_CHECK_API 仅支持 http/https URL",
      },
      1
    );
  }

  url.searchParams.set("appUk", opts.appUk);
  if (opts.region) {
    url.searchParams.set("serviceSite", opts.region);
  }

  let response: { statusCode: number; body: unknown };
  try {
    response = await httpGetJson(url, {
      Accept: "application/json",
      "jean-token": opts.token,
    });
  } catch (err: unknown) {
    output({ success: false, reason: `请求失败: ${errorMessage(err)}` }, 1);
  }

  const parsed = parseCombinedRealtimeConfig(
    response.body,
    response.statusCode,
    opts.env
  );
  output(
    {
      success: true,
      deploy: parsed.deploy,
      loadBalancer: parsed.loadBalancer,
    },
    0
  );
}

main();
