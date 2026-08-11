/**
 * SkyEye TLB 查询：POST /personal-open-api/query/tlb/*
 * 支持请求次数、平均耗时。
 */

import { readCache, retryAuthRefresh, tryAutoLogin, getSkyEyeAuthHeaders, type SkyEyeCacheEntry } from "./skyeye-auth.ts";
import { SkyEyeApi } from "./skyeye-api.ts";
import { logVerbose } from "./verbose.ts";

/** tlb 子命令 → API URL 映射 */
const TLB_SUBCOMMAND_MAP: Record<string, string> = {
  "request-count": SkyEyeApi.TLB_REQUEST_COUNT_API,
  "request-avg-elapsed": SkyEyeApi.TLB_REQUEST_AVG_ELAPSED_API,
};

export const TLB_SUBCOMMANDS = Object.keys(TLB_SUBCOMMAND_MAP);

export interface SkyEyeTlbQueryParams {
  subcommand: string;
  env: string;
  beginTime?: string;
  endTime?: string;
  minutes?: number;
  stepSecond?: number;
  queryRegion?: string;
  logicalIdc?: string;
  appUk?: string;
  host?: string;
  productLineName?: string;
  requestMethod?: string;
  requestUri?: string;
  status?: string;
  groupBy?: string;
}

function parseArgvValue(flag: string): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag && i + 1 < args.length) return args[i + 1]?.trim();
    if (arg.startsWith(flag + "=")) return arg.slice(flag.length + 1).trim();
  }
  return undefined;
}

function parseArgvNumber(flag: string): number | undefined {
  const v = parseArgvValue(flag);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function getTlbQueryParamsFromArgv(subcommand: string): SkyEyeTlbQueryParams {
  return {
    subcommand,
    env: parseArgvValue("--env") ?? "",
    beginTime: parseArgvValue("--beginTime") ?? parseArgvValue("--begin"),
    endTime: parseArgvValue("--endTime") ?? parseArgvValue("--end"),
    minutes: parseArgvNumber("--minutes"),
    stepSecond: parseArgvNumber("--stepSecond"),
    queryRegion: parseArgvValue("--queryRegion")?.trim(),
    logicalIdc: parseArgvValue("--logicalIdc"),
    appUk: parseArgvValue("--appUk"),
    host: parseArgvValue("--host"),
    productLineName: parseArgvValue("--productLineName"),
    requestMethod: parseArgvValue("--requestMethod"),
    requestUri: parseArgvValue("--requestUri"),
    status: parseArgvValue("--status"),
    groupBy: parseArgvValue("--groupBy"),
  };
}

function buildTlbRequestBody(params: SkyEyeTlbQueryParams): Record<string, unknown> {
  const { beginTime, endTime } = SkyEyeApi.resolveQueryTimeRange(
    { beginTime: params.beginTime, endTime: params.endTime, minutes: params.minutes },
    30
  );

  const body: Record<string, unknown> = { env: params.env, beginTime, endTime };
  body.queryRegion = SkyEyeApi.normalizeQueryRegion(params.queryRegion);
  if (params.stepSecond !== undefined) body.stepSecond = params.stepSecond;
  if (params.logicalIdc !== undefined) body.logicalIdc = params.logicalIdc;
  if (params.appUk !== undefined) body.appUk = params.appUk;
  if (params.host !== undefined) body.host = params.host;
  if (params.productLineName !== undefined) body.productLineName = params.productLineName;
  if (params.requestMethod !== undefined) body.requestMethod = params.requestMethod;
  if (params.requestUri !== undefined) body.requestUri = params.requestUri;
  if (params.status !== undefined) body.status = params.status;
  if (params.groupBy !== undefined) body.groupBy = params.groupBy;
  return body;
}

async function queryTlb(
  entry: SkyEyeCacheEntry,
  params: SkyEyeTlbQueryParams
): Promise<{ success?: boolean; code?: number; result?: unknown; message?: string } | undefined> {
  const apiUrl = TLB_SUBCOMMAND_MAP[params.subcommand];
  if (!apiUrl) {
    console.error(`未知的 tlb 子命令: ${params.subcommand}`);
    process.exit(1);
  }
  if (!params.env) {
    console.error("queryTlb 要求指定一个环境：--env <...>");
    process.exit(1);
  }

  const body = buildTlbRequestBody(params);
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: getSkyEyeAuthHeaders(entry),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    console.error("失败: tlb 查询接口返回状态码", res.status);
    process.exit(1);
  }

  const data = (await res.json()) as { success?: boolean; code?: number; result?: unknown; message?: string };
  if (data?.code === 1) return data;
  if (data?.success !== true) {
    console.error("查询失败:", data?.message ?? data);
    process.exit(1);
  }
  return data;
}

export async function runQueryTlb(subcommand: string): Promise<void> {
  let entry = readCache();
  if (!entry) {
    entry = tryAutoLogin();
  }
  if (!entry) {
    console.error("未找到缓存的 token，请先执行: skyeye auth login 或 skyeye auth --personalAccessToken <key>");
    process.exit(1);
  }

  const params = getTlbQueryParamsFromArgv(subcommand);
  logVerbose("runQueryTlb params", params);
  let data = await queryTlb(entry, params);
  if (data?.code === 1) {
    const newEntry = await retryAuthRefresh();
    if (newEntry) {
      data = await queryTlb(newEntry, params);
    }
  }
  if (data?.code === 1) {
    console.error("权限认证过期，请执行 skyeye auth login 或 skyeye auth --personalAccessToken <key> 更新");
    process.exit(1);
  }
  if (data?.success === true) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data) console.error("查询失败:", data?.message ?? data);
  process.exit(1);
}
