/**
 * SkyEye API 时间：`YYYY-MM-DD HH:mm:ss.000`，毫秒统一为 000。
 */

export class SkyEyeDateTime {
  /** 固定毫秒后缀，与接口约定一致 */
  static readonly MS_SUFFIX = ".000";

  /** 由当前时刻生成 API 用时间字符串（毫秒恒为 000） */
  static fromDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${y}-${m}-${day} ${h}:${min}:${s}${SkyEyeDateTime.MS_SUFFIX}`;
  }

  /**
   * 规范化 CLI/用户传入的 beginTime、endTime：日期时间部分保留，毫秒改为 000。
   * 支持 `... HH:mm:ss` 或 `... HH:mm:ss.xxx`（1～3 位小数）。
   */
  static normalize(raw: string | undefined): string | undefined {
    if (raw === undefined || raw === "") return raw;
    const s = raw.trim();
    const m = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/.exec(s);
    if (m) return `${m[1]}${SkyEyeDateTime.MS_SUFFIX}`;
    return s;
  }
}
