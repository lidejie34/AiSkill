/**
 * SkyEye 天网日志技能入口（通过全局命令 skyeye 调用）。
 * 子命令：auth（刷新并缓存 token）、queryLog（查询日志）、
 *         queryChecklist <sub>（checklist 指标）、queryTlb <sub>（TLB 指标）。
 *
 * 用法：
 *   skyeye auth --personalAccessToken <key> | skyeye auth --personalAccessToken=<key>
 *   skyeye auth login
 *   skyeye queryLog --minutes 5 [--priority INFO] [--env uat] ...
 *   skyeye queryChecklist execute-count --env product --minutes 30 ...
 *   skyeye queryTlb request-count --env product --minutes 30 ...
 */
// @ts-ignore
import { fetchToken, writeCache, getCachePath, readRawCacheEntry, clearCache, LOGIN_TYPE_TCODE, LOGIN_TYPE_PERSONAL_ACCESS_TOKEN } from "./skyeye-auth.ts";
// @ts-ignore
import { runQueryLog } from "./skyeye-log.ts";
// @ts-ignore
import { runQueryChecklist, CHECKLIST_SUBCOMMANDS } from "./skyeye-checklist.ts";
// @ts-ignore
import { runQueryTlb, TLB_SUBCOMMANDS } from "./skyeye-tlb.ts";
// @ts-ignore
import { setVerbose, stripVerboseArg, logVerbose } from "./verbose.ts";
import { execSync } from "child_process";

function getSubcommand(): string | null {
  const args = process.argv.slice(2);
  logVerbose("args", args);
  const sub = args.find((a) => a === "auth" || a === "queryLog" || a === "queryChecklist" || a === "queryTlb");
  return sub ?? null;
}

function parseauthArgs(): { personalAccessToken: string; authAction: string } {
  const args = process.argv.slice(2);
  let personalAccessToken = "";
  let authAction = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--personalAccessToken=")) {
      personalAccessToken = arg.slice("--personalAccessToken=".length).trim();
    } else if (arg === "--personalAccessToken" && args[i + 1] !== undefined) {
      personalAccessToken = String(args[i + 1]).trim();
      i++;
    } else if (arg === "login" || arg === "logout") {
      authAction = arg;
    }
  }
  logVerbose("personalAccessToken", personalAccessToken);
  logVerbose("authAction", authAction);
  return { personalAccessToken, authAction };
}

async function runauth(): Promise<void> {
  const args = process.argv.slice(2);
  const { personalAccessToken, authAction } = parseauthArgs();

  if (authAction === "logout") {
    const had = clearCache();
    if (had) {
      console.log("已清除 skyeye 缓存:", getCachePath());
    } else {
      console.log("缓存为空，无需清除:", getCachePath());
    }
    return;
  }

  if (authAction === "login") {
    let token: string;
    try {
      token = execSync("tcode auth token", { encoding: "utf-8", timeout: 15000 }).trim();
    } catch {
      console.error("登录失败：无法获取 tcode auth token，请升级 tcode 版本：https://tws.17usoft.com/copilot/skill/detail?slug=skyeye&space=tongcheng");
      process.exit(1);
    }
    if (!token) {
      console.error("登录失败：tcode auth token 返回为空，请升级 tcode 版本：https://tws.17usoft.com/copilot/skill/detail?slug=skyeye&space=tongcheng");
      process.exit(1);
    }
    const prev = readRawCacheEntry();
    writeCache({
      personalAccessToken: prev?.personalAccessToken ?? "",
      apiToken: prev?.apiToken ?? "",
      accessToken: token,
      loginType: LOGIN_TYPE_TCODE,
    });
    console.log("登录成功，accessToken 已写入缓存:", getCachePath());
    return;
  }

  if (personalAccessToken) {
    const apiToken = await fetchToken(personalAccessToken);
    const prev = readRawCacheEntry();
    writeCache({
      personalAccessToken,
      apiToken,
      accessToken: prev?.accessToken,
      loginType: LOGIN_TYPE_PERSONAL_ACCESS_TOKEN,
    });
    logVerbose("登录成功，token 已写入缓存:", getCachePath());
    return;
  }
  console.error("账号信息为空。参数解析不匹配，各位置 key/value 如下：");
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const value = args[i + 1];
    console.error(`  [${i}] key=${JSON.stringify(key)}, value=${value !== undefined ? JSON.stringify(value) : "(无)"}`);
  }
  console.error("请参考用法: skyeye auth login | skyeye auth --personalAccessToken <key> | skyeye auth --personalAccessToken=<key>");
  process.exit(1);
}

async function main(): Promise<void> {
  setVerbose(process.argv.includes("--verbose"));
  stripVerboseArg();
  logVerbose("[缓存路径]", getCachePath());
  const sub = getSubcommand();
  if (sub === "auth") {
    await runauth();
    return;
  }
  if (sub === "queryLog") {
    await runQueryLog();
    return;
  }
  if (sub === "queryChecklist") {
    const args = process.argv.slice(2);
    const subIdx = args.indexOf("queryChecklist");
    const checklistSub = args[subIdx + 1];
    if (!checklistSub || !CHECKLIST_SUBCOMMANDS.includes(checklistSub)) {
      console.error(`queryChecklist 需要指定子命令，可选：${CHECKLIST_SUBCOMMANDS.join(", ")}`);
      process.exit(1);
    }
    await runQueryChecklist(checklistSub);
    return;
  }
  if (sub === "queryTlb") {
    const args = process.argv.slice(2);
    const subIdx = args.indexOf("queryTlb");
    const tlbSub = args[subIdx + 1];
    if (!tlbSub || !TLB_SUBCOMMANDS.includes(tlbSub)) {
      console.error(`queryTlb 需要指定子命令，可选：${TLB_SUBCOMMANDS.join(", ")}`);
      process.exit(1);
    }
    await runQueryTlb(tlbSub);
    return;
  }

  console.log(`用法:
  auth: 刷新并缓存租户 token
    skyeye auth login                                   (通过 tcode auth token 自动获取 accessToken)
    skyeye auth --personalAccessToken <key>  或  --personalAccessToken=<key>

  auth logout: 清除 skyeye 缓存
    skyeye auth logout

  queryLog: 查询天网日志（需先执行 auth）；--appUks 必填
    时间：--minutes 或 --begin/--end；均未指定则默认最近 15 分钟（SkyEyeApi.resolveQueryTimeRange）
    最近 N 分钟:
      skyeye queryLog --minutes 5 [--priority INFO] [--env uat] [--pageSize 5]
    指定时间范围:
      skyeye queryLog --begin "2026-03-04 17:00:00.000" --end "2026-03-04 17:10:00.000" [options]

  queryChecklist <sub>: 查询 checklist 指标（需先执行 auth）；--env 必填
    子命令：${CHECKLIST_SUBCOMMANDS.join(", ")}
    示例：
      skyeye queryChecklist execute-count --env product --minutes 30
      skyeye queryChecklist biz-exception-rate --env product --beginTime "2026-04-24 10:00:00.000" --endTime "2026-04-24 10:30:00.000" --dataKey "p::s::m"

  queryTlb <sub>: 查询 TLB 指标（需先执行 auth）；--env 必填
    子命令：${TLB_SUBCOMMANDS.join(", ")}
    示例：
      skyeye queryTlb request-count --env product --minutes 30
      skyeye queryTlb request-avg-elapsed --env product --beginTime "2026-04-24 10:00:00.000" --endTime "2026-04-24 10:30:00.000" --appUk my-app

  可选: --priority DEBUG|INFO|WARN|ERROR|FATAL 或 0-4  --env  --envName
        --modules  --categories  --subCategories  --filter1s  --filter2s  --appUks  --ips
        (数组参数支持逗号分隔 "a,b,c" 或 JSON 数组 '["a","b"]' 或多次 --flag val)
        --contextId  --indexContext  --pageSize
        （消息内容检索请用 --indexContext；不要用 --keyword，该参数无效）
        --ignoreEnvParamAsDataFilter true|false  (默认 false；true 时请求体不写 env，同区域多环境；?env= 仍用 --env)`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
