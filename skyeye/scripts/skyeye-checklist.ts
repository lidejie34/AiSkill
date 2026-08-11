/**
 * SkyEye Checklist 查询：POST /personal-open-api/query/checklist/*
 * 支持执行次数、业务异常次数/率、异常次数/率、300ms 内次数/占比、总耗时、平均耗时、最大执行时间。
 */

import { readCache, retryAuthRefresh, tryAutoLogin, getSkyEyeAuthHeaders, type SkyEyeCacheEntry } from "./skyeye-auth.ts";
import { SkyEyeApi } from "./skyeye-api.ts";
import { logVerbose } from "./verbose.ts";

/** checklist 子命令 → API URL 映射 */
const CHECKLIST_SUBCOMMAND_MAP: Record<string, string> = {
  "execute-count": SkyEyeApi.CHECKLIST_EXECUTE_COUNT_API,
  "biz-exception-count": SkyEyeApi.CHECKLIST_BIZ_EXCEPTION_COUNT_API,
  "biz-exception-rate": SkyEyeApi.CHECKLIST_BIZ_EXCEPTION_RATE_API,
  "exception-count": SkyEyeApi.CHECKLIST_EXCEPTION_COUNT_API,
  "exception-rate": SkyEyeApi.CHECKLIST_EXCEPTION_RATE_API,
  "lt300ms-count": SkyEyeApi.CHECKLIST_LT300MS_COUNT_API,
  "lt300ms-rate": SkyEyeApi.CHECKLIST_LT300MS_RATE_API,
  "total-time": SkyEyeApi.CHECKLIST_TOTAL_TIME_API,
  "avg-time": SkyEyeApi.CHECKLIST_AVG_TIME_API,
  "max-execute-time": SkyEyeApi.CHECKLIST_MAX_EXECUTE_TIME_API,
};

export const CHECKLIST_SUBCOMMANDS = Object.keys(CHECKLIST_SUBCOMMAND_MAP);

export interface SkyEyeChecklistQueryParams {
  subcommand: string;
  env: string;
  beginTime?: string;
  endTime?: string;
  minutes?: number;
  stepSecond?: number;
  queryRegion?: string;
  logicalIdc?: string;
  productLine?: string;
  serviceName?: string;
  methodName?: string;
  dataKey?: string;
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

export function getChecklistQueryParamsFromArgv(subcommand: string): SkyEyeChecklistQueryParams {
  const env = parseArgvValue("--env") ?? "";
  return {
    subcommand,
    env,
    beginTime: parseArgvValue("--beginTime") ?? parseArgvValue("--begin"),
    endTime: parseArgvValue("--endTime") ?? parseArgvValue("--end"),
    minutes: parseArgvNumber("--minutes"),
    stepSecond: parseArgvNumber("--stepSecond"),
    queryRegion: parseArgvValue("--queryRegion")?.trim(),
    logicalIdc: parseArgvValue("--logicalIdc"),
    productLine: parseArgvValue("--productLine"),
    serviceName: parseArgvValue("--serviceName"),
    methodName: parseArgvValue("--methodName"),
    dataKey: parseArgvValue("--dataKey"),
    groupBy: parseArgvValue("--groupBy"),
  };
}

function buildChecklistRequestBody(params: SkyEyeChecklistQueryParams): Record<string, unknown> {
  const { beginTime, endTime } = SkyEyeApi.resolveQueryTimeRange(
    { beginTime: params.beginTime, endTime: params.endTime, minutes: params.minutes },
    30
  );

  const body: Record<string, unknown> = { env: params.env, beginTime, endTime };
  body.queryRegion = SkyEyeApi.normalizeQueryRegion(params.queryRegion);
  if (params.stepSecond !== undefined) body.stepSecond = params.stepSecond;
  if (params.logicalIdc !== undefined) body.logicalIdc = params.logicalIdc;
  if (params.productLine !== undefined) body.productLine = params.productLine;
  if (params.serviceName !== undefined) body.serviceName = params.serviceName;
  if (params.methodName !== undefined) body.methodName = params.methodName;
  if (params.dataKey !== undefined) body.dataKey = params.dataKey;
  if (params.groupBy !== undefined) body.groupBy = params.groupBy;
  return body;
}

async function queryChecklist(
  entry: SkyEyeCacheEntry,
  params: SkyEyeChecklistQueryParams
): Promise<{ success?: boolean; code?: number; result?: unknown; message?: string } | undefined> {
  const apiUrl = CHECKLIST_SUBCOMMAND_MAP[params.subcommand];
  if (!apiUrl) {
    console.error(`未知的 checklist 子命令: ${params.subcommand}`);
    process.exit(1);
  }
  if (!params.env) {
    console.error("queryChecklist 要求指定一个环境：--env <...>");
    process.exit(1);
  }
  if (!params.dataKey && !params.productLine && !params.serviceName && !params.methodName) {
    console.error("queryChecklist 要求至少填写一个筛选条件：--dataKey 或 --productLine / --serviceName / --methodName");
    process.exit(1);
  }

  const body = buildChecklistRequestBody(params);
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: getSkyEyeAuthHeaders(entry),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    console.error("失败: checklist 查询接口返回状态码", res.status);
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

export async function runQueryChecklist(subcommand: string): Promise<void> {
  let entry = readCache();
  if (!entry) {
    entry = tryAutoLogin();
  }
  if (!entry) {
    console.error("未找到缓存的 token，请先执行: skyeye auth login 或 skyeye auth --personalAccessToken <key>");
    process.exit(1);
  }

  const params = getChecklistQueryParamsFromArgv(subcommand);
  logVerbose("runQueryChecklist params", params);
  let data = await queryChecklist(entry, params);
  if (data?.code === 1) {
    const newEntry = await retryAuthRefresh();
    if (newEntry) {
      data = await queryChecklist(newEntry, params);
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
