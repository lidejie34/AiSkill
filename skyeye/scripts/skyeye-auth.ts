/**
 * SkyEye 租户 Token：缓存读写、从开放接口获取 apiToken。
 * 缓存目录：本 skill 的 assets/skyeye-cache，map 键 skyeye，值 { personalAccessToken, apiToken, accessToken? }。
 * 鉴权头：优先用 personalAccessToken，否则用 accessToken，写入 skyeye-sso-access-token；若存在 apiToken 则同时带 skyeye-personal-auth-token。
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
// @ts-ignore
import { logVerbose } from "./verbose.ts";
// @ts-ignore
import { SkyEyeApi } from "./skyeye-api.ts";
const CACHE_KEY = "skyeye";
const CACHE_DIR = "skyeye-cache";
const CACHE_FILENAME = "cache.json";

/** 本 skill 根目录（与 SKILL.md 同层） */
function getSkillRoot(): string {
  // @ts-ignore
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "..");
}

export const LOGIN_TYPE_TCODE = "tcode" as const;
export const LOGIN_TYPE_PERSONAL_ACCESS_TOKEN = "personalAccessToken" as const;

export type LoginType = typeof LOGIN_TYPE_TCODE | typeof LOGIN_TYPE_PERSONAL_ACCESS_TOKEN;

export interface SkyEyeCacheEntry {
  personalAccessToken: string;
  apiToken: string;
  /** auth --accessToken 写入的 SSO 凭证，与 personalAccessToken 二选一或并存；请求头见 {@link getSkyEyeAuthHeaders} */
  accessToken?: string;
  /** 登录模式：tcode 表示 skyeye auth login，personalAccessToken 表示 skyeye auth --personalAccessToken */
  loginType?: LoginType;
}

export type CacheMap = Record<string, SkyEyeCacheEntry>;

function getCacheDir(): string {
  return path.join(getSkillRoot(), "assets", CACHE_DIR);
}

export function getCachePath(): string {
  return path.join(getCacheDir(), CACHE_FILENAME);
}

function readCacheMap(): CacheMap {
  try {
    const p = getCachePath();
    const raw = fs.readFileSync(p, "utf-8");
    logVerbose("readCacheMap", raw);
    const map = JSON.parse(raw) as CacheMap;
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

function writeCacheMap(map: CacheMap): void {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, CACHE_FILENAME), JSON.stringify(map, null, 2), "utf-8");
}

function hasUsableCache(entry: SkyEyeCacheEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.apiToken?.trim()) return true;
  const sso =
    (entry.personalAccessToken ?? "").trim() || (entry.accessToken ?? "").trim();
  return sso.length > 0;
}

/**
 * 个人 API Key 与 SSO accessToken 二选一取非空，用于 `skyeye-sso-access-token`。
 */
export function getSsoAccessTokenValue(entry: SkyEyeCacheEntry): string {
  return (entry.accessToken ?? "").trim();
}

/**
 * 技能请求鉴权头：必含 Content-Type。
 * loginType 为 tcode 时使用 skyeye-sso-access-token，否则使用 skyeye-personal-auth-token。
 */
export function getSkyEyeAuthHeaders(entry: SkyEyeCacheEntry): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (entry.loginType === LOGIN_TYPE_TCODE) {
    const sso = getSsoAccessTokenValue(entry);
    if (sso) h["skyeye-sso-access-token"] = sso;
  } else {
    if (entry.apiToken?.trim()) h["skyeye-personal-auth-token"] = entry.apiToken.trim();
  }
  return h;
}

/** 未校验是否可发起请求，用于 auth 合并写回 */
export function readRawCacheEntry(): SkyEyeCacheEntry | undefined {
  const map = readCacheMap();
  return map[CACHE_KEY];
}

export function readCache(): SkyEyeCacheEntry | null {
  const map = readCacheMap();
  const entry = map[CACHE_KEY];
  if (!hasUsableCache(entry)) return null;
  return entry;
}

export function writeCache(entry: SkyEyeCacheEntry): void {
  const map = readCacheMap();
  map[CACHE_KEY] = entry;
  writeCacheMap(map);
  logVerbose("[已写入本地缓存] assets/skyeye-cache");
}

/** 清除全部缓存，返回 true 表示有缓存被清除 */
export function clearCache(): boolean {
  const map = readCacheMap();
  const had = CACHE_KEY in map;
  if (had) {
    delete map[CACHE_KEY];
    writeCacheMap(map);
  }
  return had;
}

/**
 * 调用租户 Token 接口，成功返回 apiToken，失败抛出或 process.exit(1)。
 */
export async function fetchToken(personalAccessToken: string): Promise<string> {
  const res = await fetch(SkyEyeApi.TOKEN_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiAccessKey: String(personalAccessToken).trim(),
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    console.error("失败: 获取 token 接口返回状态码", res.status);
    process.exit(1);
  }

  const data = (await res.json()) as { success?: boolean; result?: string; message?: string };
  if (data?.success !== true || !data?.result?.trim()) {
    console.error("登录失败:", data?.message ?? "success 不为 true 或 result 为空", data);
    process.exit(1);
  }

  return data.result.trim();
}

/**
 * 使用缓存中的 personalAccessToken 重新获取 token 并写回缓存。
 * 返回刷新后的缓存条目，若缓存无 key 则返回 null。
 */
export async function refreshPersonalToken(): Promise<SkyEyeCacheEntry | null> {
  const entry = readCache();
  if (!entry?.personalAccessToken?.trim()) return null;
  const apiToken = await fetchToken(entry.personalAccessToken);
  const newEntry: SkyEyeCacheEntry = { ...entry, apiToken, loginType: LOGIN_TYPE_PERSONAL_ACCESS_TOKEN };
  writeCache(newEntry);
  return newEntry;
}

/**
 * 尝试通过 tcode auth token 自动登录，成功则更新缓存并返回新条目，失败返回 null。
 */
export function tryAutoLogin(): SkyEyeCacheEntry | null {
  try {
    const token = execSync("tcode auth token", { encoding: "utf-8", timeout: 15000 }).trim();
    if (!token) return null;
    const prev = readRawCacheEntry();
    const newEntry: SkyEyeCacheEntry = {
      personalAccessToken: prev?.personalAccessToken ?? "",
      apiToken: prev?.apiToken ?? "",
      accessToken: token,
      loginType: LOGIN_TYPE_TCODE,
    };
    writeCache(newEntry);
    logVerbose("[tryAutoLogin] 通过 tcode auth token 自动刷新 accessToken 成功");
    return newEntry;
  } catch {
    return null;
  }
}

/**
 * 根据 loginType 选择刷新策略：tcode 模式自动重新登录，personalAccessToken 模式刷新 token。
 * 返回刷新后的缓存条目，失败返回 null。
 */
export async function retryAuthRefresh(): Promise<SkyEyeCacheEntry | null> {
  const entry = readCache();
  const loginType = entry?.loginType ?? LOGIN_TYPE_TCODE;
  logVerbose(`[retryAuthRefresh] loginType=${loginType}，开始刷新认证`);
  if (loginType === LOGIN_TYPE_TCODE) {
    logVerbose("[retryAuthRefresh] 使用 tcode 自动重新登录");
    return tryAutoLogin();
  }
  logVerbose("[retryAuthRefresh] 使用 personalAccessToken 刷新 token");
  return refreshPersonalToken();
}
