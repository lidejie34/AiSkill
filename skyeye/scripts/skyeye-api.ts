/**
 * SkyEye Open API 基址与完整 URL。域名与路径在此统一维护。
 * queryLog / queryChecklist / queryTlb：`resolveQueryTimeRange`、`normalizeQueryRegion`。
 */

// @ts-ignore
import { SkyEyeDateTime } from "./skyeye-datetime.ts";

/** 对外 Open API 域名（Token 等） */
const HOST_OPEN = "http://szapi.skyeye.17usoft.com";

/** queryLog：CLI 传入的 begin/end/minutes */
export interface SkyEyeQueryTimeInput {
  beginTime?: string;
  endTime?: string;
  /** 最近 N 分钟；>0 时优先于起止时间与默认值 */
  minutes?: number;
}

export class SkyEyeApi {
  private static readonly _prefix = "/personal-open-api";

  static readonly TOKEN_API = `${HOST_OPEN}${SkyEyeApi._prefix}/query/token`;
  static readonly LOG_API = `${HOST_OPEN}${SkyEyeApi._prefix}/query/skynet/log`;

  /** Checklist 接口路径前缀 */
  private static readonly _checklistPrefix = `${HOST_OPEN}${SkyEyeApi._prefix}/query/checklist`;
  static readonly CHECKLIST_EXECUTE_COUNT_API = `${SkyEyeApi._checklistPrefix}/execute/count`;
  static readonly CHECKLIST_BIZ_EXCEPTION_COUNT_API = `${SkyEyeApi._checklistPrefix}/biz-exception/count`;
  static readonly CHECKLIST_BIZ_EXCEPTION_RATE_API = `${SkyEyeApi._checklistPrefix}/biz-exception/rate`;
  static readonly CHECKLIST_EXCEPTION_COUNT_API = `${SkyEyeApi._checklistPrefix}/exception/count`;
  static readonly CHECKLIST_EXCEPTION_RATE_API = `${SkyEyeApi._checklistPrefix}/exception/rate`;
  static readonly CHECKLIST_LT300MS_COUNT_API = `${SkyEyeApi._checklistPrefix}/lt300ms/count`;
  static readonly CHECKLIST_LT300MS_RATE_API = `${SkyEyeApi._checklistPrefix}/lt300ms/rate`;
  static readonly CHECKLIST_TOTAL_TIME_API = `${SkyEyeApi._checklistPrefix}/total-time`;
  static readonly CHECKLIST_AVG_TIME_API = `${SkyEyeApi._checklistPrefix}/avg-time`;
  static readonly CHECKLIST_MAX_EXECUTE_TIME_API = `${SkyEyeApi._checklistPrefix}/max-execute-time`;

  /** TLB 接口路径前缀 */
  private static readonly _tlbPrefix = `${HOST_OPEN}${SkyEyeApi._prefix}/query/tlb`;
  static readonly TLB_REQUEST_COUNT_API = `${SkyEyeApi._tlbPrefix}/request/count`;
  static readonly TLB_REQUEST_AVG_ELAPSED_API = `${SkyEyeApi._tlbPrefix}/request/avg-elapsed`;

  /** 未传 `--minutes` 且未同时传 begin/end 时，默认查询最近 N 分钟（当前为 15） */
  static readonly DEFAULT_QUERY_MINUTES = 15;

  /** 集团通用-全国 */
  static readonly QUERY_REGION_GENERAL_CN_ALL = "general_cn_all";
  /** 集团通用-新加坡 */
  static readonly QUERY_REGION_GENERAL_AP_SOUTHEAST_1 = "general_ap-southeast-1";
  /** 新生支付-华东 */
  static readonly QUERY_REGION_NEWPAY_CN_EAST = "newpay_cn_east";
  /** 新生支付-香港 */
  static readonly QUERY_REGION_NEWPAY_AP_EAST_1 = "newpay_ap-east-1";

  /**
   * 统一解析查询区域（请求体 / Query 与后端约定参数值）：
   * - 未传、空串、或历史别名 `default` → {@link SkyEyeApi.QUERY_REGION_GENERAL_CN_ALL}（集团通用-全国）
   * - `newpay_cn_east` → {@link SkyEyeApi.QUERY_REGION_NEWPAY_CN_EAST}（新生支付-华东）
   * - `newpay_ap-east-1` → {@link SkyEyeApi.QUERY_REGION_NEWPAY_AP_EAST_1}（新生支付-香港）
   * - `general_ap-southeast-1` → {@link SkyEyeApi.QUERY_REGION_GENERAL_AP_SOUTHEAST_1}（集团通用-新加坡）
   * - 已是上述 canonical 值则原样返回（大小写不敏感匹配 canonical）
   * - 其余字符串原样透传（自定义区域）
   */
  static normalizeQueryRegion(raw: string | undefined): string {
    const s = (raw ?? "").trim();
    if (s === "") return SkyEyeApi.QUERY_REGION_GENERAL_CN_ALL;

    const lower = s.toLowerCase();
    if (lower === "default" || lower === SkyEyeApi.QUERY_REGION_GENERAL_CN_ALL) {
      return SkyEyeApi.QUERY_REGION_GENERAL_CN_ALL;
    }
    if (lower === SkyEyeApi.QUERY_REGION_NEWPAY_CN_EAST) return SkyEyeApi.QUERY_REGION_NEWPAY_CN_EAST;
    if (lower === SkyEyeApi.QUERY_REGION_NEWPAY_AP_EAST_1) return SkyEyeApi.QUERY_REGION_NEWPAY_AP_EAST_1;
    if (lower === SkyEyeApi.QUERY_REGION_GENERAL_AP_SOUTHEAST_1) return SkyEyeApi.QUERY_REGION_GENERAL_AP_SOUTHEAST_1;
    return s;
  }

  /**
   * 统一解析时间范围（毫秒在 `SkyEyeDateTime` 中规范为 `.000`）：
   * 1. `minutes > 0` → 当前时刻起向前 N 分钟；
   * 2. 否则若 begin、end 均非空 → 使用规范化后的起止时间；
   * 3. 否则 → 最近 `defaultMinutes`（未传则 `DEFAULT_QUERY_MINUTES`）分钟。
   */
  static resolveQueryTimeRange(input: SkyEyeQueryTimeInput, defaultMinutes?: number): { beginTime: string; endTime: string } {
    const minutes = input.minutes;
    if (minutes != null && Number.isFinite(minutes) && minutes > 0) {
      const end = new Date();
      const start = new Date(end.getTime() - minutes * 60 * 1000);
      return {
        beginTime: SkyEyeDateTime.fromDate(start),
        endTime: SkyEyeDateTime.fromDate(end),
      };
    }
    const b = input.beginTime?.trim();
    const e = input.endTime?.trim();
    if (b && e) {
      return {
        beginTime: SkyEyeDateTime.normalize(b) ?? b,
        endTime: SkyEyeDateTime.normalize(e) ?? e,
      };
    }
    const end = new Date();
    const start = new Date(end.getTime() - (defaultMinutes ?? SkyEyeApi.DEFAULT_QUERY_MINUTES) * 60 * 1000);
    return {
      beginTime: SkyEyeDateTime.fromDate(start),
      endTime: SkyEyeDateTime.fromDate(end),
    };
  }
}
