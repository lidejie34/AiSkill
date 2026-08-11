/**
 * check-env.js
 *
 * 检查 Node.js 环境是否满足运行 TS 脚本的要求。
 * 本文件故意使用 .js 扩展名和 ES5 兼容语法，确保任意版本 Node.js 都能执行。
 *
 * 用法:
 *   node scripts/check-env.js
 *
 * 输出 (JSON):
 *   {
 *     "ok": true,
 *     "node": "v22.12.0",
 *     "major": 22,
 *     "minor": 12,
 *     "message": "Node.js 环境满足要求"
 *   }
 *
 *   {
 *     "ok": false,
 *     "node": "v18.19.0",
 *     "major": 18,
 *     "minor": 19,
 *     "required": ">=22.6.0",
 *     "message": "Node.js 版本过低 (v18.19.0)，需要 >=22.6.0 才能运行 TS 脚本",
 *     "hint": "请升级 Node.js: https://nodejs.org/en/download"
 *   }
 *
 * 退出码: 0 = 满足要求, 1 = 不满足
 */

"use strict";

var REQUIRED_MAJOR = 22;
var REQUIRED_MINOR = 6;
var REQUIRED_LABEL = ">=" + REQUIRED_MAJOR + "." + REQUIRED_MINOR + ".0";
var DOWNLOAD_URL = "https://nodejs.org/en/download";

var version = process.version; // e.g. "v22.12.0"
var match = version.match(/^v(\d+)\.(\d+)\.(\d+)/);

if (!match) {
  var result = JSON.stringify({
    ok: false,
    node: version,
    major: null,
    minor: null,
    required: REQUIRED_LABEL,
    message: "无法解析 Node.js 版本号: " + version,
    hint: "请安装最新 LTS 版本: " + DOWNLOAD_URL,
  });
  process.stdout.write(result + "\n");
  process.exit(1);
}

var major = parseInt(match[1], 10);
var minor = parseInt(match[2], 10);

var ok =
  major > REQUIRED_MAJOR ||
  (major === REQUIRED_MAJOR && minor >= REQUIRED_MINOR);

if (ok) {
  process.stdout.write(
    JSON.stringify({
      ok: true,
      node: version,
      major: major,
      minor: minor,
      message: "Node.js 环境满足要求",
    }) + "\n"
  );
  process.exit(0);
} else {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      node: version,
      major: major,
      minor: minor,
      required: REQUIRED_LABEL,
      message:
        "Node.js 版本过低 (" +
        version +
        ")，需要 " +
        REQUIRED_LABEL +
        " 才能运行 TS 脚本",
      hint: "请升级 Node.js: " + DOWNLOAD_URL,
    }) + "\n"
  );
  process.exit(1);
}
