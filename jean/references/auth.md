# Jean Token 获取流程

当 SKILL.md 中的 token 缓存验证失败（401 或缓存不存在/为空）时，按以下路径依次尝试获取新 token。成功一个即停止，每条路径获取到 token 后都必须执行最后的**写入缓存并验证**步骤。

路径优先级：A（tcode CLI）→ B（claude-in-chrome）→ C（chrome-devtools skill）→ D（TS 脚本）→ E（手动）。

---

## 路径 A：tcode CLI（**推荐，最便捷**）

> tcode 是公司内部 Skill CLI，封装了登录与取 token，并能快速安装公司内 skill。**首选路径**。

### 步骤 1：检测是否已安装

```bash
command -v tcode >/dev/null 2>&1 && echo INSTALLED || echo MISSING
```

- `INSTALLED` → 进入"步骤 2：检查版本"
- `MISSING` → 进入"步骤 1a：引导安装"

### 步骤 1a：引导安装（必须用户同意才执行）

告知用户：
> tcode 是公司 Skill CLI，可一键完成 Jean 登录拿 token，且后续可快速安装/升级公司内 skill（无需重复执行安装脚本）。是否安装？

安装命令（用户同意后由 Agent 执行）：

- macOS / Linux：
  ```bash
  curl -fsSL https://oss.ly.com/skills/install.sh | bash
  ```
- Windows（PowerShell）：
  ```powershell
  irm https://oss.ly.com/skills/install.ps1 | iex
  ```

安装完成后回到"步骤 2"。若用户拒绝安装，跳到路径 B。

### 步骤 2：检查版本（**硬性要求 ≥ v1.1.5**）

`tcode auth login` / `tcode auth token` 两个子命令是 **v1.1.5 引入的**，**任何低于 v1.1.5 的版本都不支持**，必须先升级，没有变通办法。

先尝试新版命令：

```bash
tcode -V 2>/dev/null
```

- 输出形如 `1.1.5` / `v1.1.5` → 解析版本号
  - **≥ v1.1.5** → 进入"步骤 3：登录并取 token"
  - **< v1.1.5** → 必须升级，进入"步骤 2a：升级"
- 命令失败 / 无输出 → 用户在跑老版 tcode（老版用 `-v` 而非 `-V`），改用：
  ```bash
  tcode -v
  ```
  老版本一律不支持 `auth` 子命令族，**必须升级**，进入"步骤 2a：升级"

### 步骤 2a：升级（必须用户同意才执行）

告知用户：

> 当前 tcode 版本低于 v1.1.5，**不支持 `auth login` / `auth token` 命令，必须升级**才能继续 tcode 路径。是否现在升级？

升级用步骤 1a 的同一条安装命令重跑，会覆盖式升级（无需先卸载）。

- 用户同意 → 执行安装命令，完成后回到"步骤 2"复检版本
- 用户拒绝 → tcode 路径不可用，**降级到路径 B**（不要尝试在低版本上跑 `tcode auth ...`，会直接失败）

### 步骤 3：登录并取 token

#### 3.1 取 token，未登录则自动登录

先尝试取 token：

```bash
tcode auth token
```

- 退出码 0 且 stdout 匹配 `^[0-9a-f]{32}$` → 已登录，进入步骤 4
- 否则（典型为 exit 1 + 提示 `✗ 未登录，请先运行: tcode auth login`）→ Agent 直接执行：

  ```bash
  tcode auth login
  ```

  该命令会打开浏览器进行 SSO/账号登录，命令本身阻塞等待登录完成后自动退出（不需要 stdin 输入）。Agent 必须**告知用户**："已为你打开 tcode 登录页面，请在浏览器中完成登录。"

  登录完成后，再次执行 `tcode auth token` 取 token，进入步骤 4。

#### 3.2 失败兜底

若 `tcode auth login` 退出后再次跑 `tcode auth token` 仍非 32 字符 hex，说明登录未完成或 tcode 异常，降级到路径 B。

### 步骤 4：写入缓存并验证

把上一步的 token 直接交给 validate-token.ts（同时完成验证 + 写缓存）：

```bash
TOKEN=$(tcode auth token | tr -d '[:space:]')
# 兜底校验：token 应为 32 字符 hex
if ! [[ "$TOKEN" =~ ^[0-9a-f]{32}$ ]]; then
  echo "tcode auth token 输出异常，请先运行 ! tcode auth login" >&2
  exit 1
fi
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/validate-token.ts --token "$TOKEN"
```

- `valid: true` → 完成，回 SKILL.md 继续后续步骤
- `valid: false` → 让用户重新执行 `! tcode auth login` 后重试一次；仍失败则降级到路径 B

---

## 路径 B：`mcp__claude-in-chrome` 工具（全自动）

> 前提：当前环境有 `mcp__claude-in-chrome` 相关工具可用。若不可用，跳到路径 C。

1. 调用 `tabs_context_mcp` 检查是否已有 `jean.corp.elong.com` 的浏览器 tab
2. 若无，创建新 tab 并导航到：`https://jean.corp.elong.com/v3/access/#/plat`
3. 用 `javascript_tool` 在该 tab 中执行脚本读取 cookie：
   ```javascript
   document.cookie.split(';')
     .find(c => c.trim().startsWith('jean_v2='))
     ?.split('=').slice(1).join('=')
   ```
4. 判断结果：
   - 拿到非空字符串 → 这就是 token，进入**写入缓存并验证**
   - 返回 `undefined` 或空字符串 → 用户未登录，告知用户："请在浏览器中打开的 Jean 页面完成登录，登录完成后告诉我。" 等用户确认后重新执行第 3 步
   - 重新读取仍为空 → 放弃路径 B，进入路径 C

---

## 路径 C：`$chrome-devtools` skill（半自动）

> 前提：当前环境有 `$chrome-devtools` skill 可用。若不可用，跳到路径 D。

1. 使用 `$chrome-devtools` skill 打开页面：`https://jean.corp.elong.com/v3/access/#/plat`
2. 在页面中执行脚本读取 cookie 中的 `jean_v2`（读取方式同路径 B 第 3 步）
3. 判断结果：
   - 拿到非空值 → 进入**写入缓存并验证**
   - 为空 → 提示用户先在浏览器中完成登录，用户确认后重试一次
   - 仍为空或 skill 不可用 → 进入路径 D

---

## 路径 D：TypeScript 脚本（打开浏览器，用户手动登录）

> 前提：当前环境有 Node.js 可用。若不可用，跳到路径 E。

执行脚本：

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/get-jean-token.ts
```

### 脚本行为说明

脚本启动后会自动打开系统 Chrome 浏览器并访问 Jean 登录页面，然后在终端阻塞等待。用户需要在浏览器完成登录后回到终端按回车。脚本随后读取浏览器 cookie 中的 `jean_v2` 值，成功时写入 `assets/jean-token` 并在终端输出。

### Agent 执行此脚本时的关键行为

- 执行脚本后**必须提示用户**："已打开 Jean 登录页面，请在浏览器中完成登录，登录完成后回到终端按回车键。"
- **不要在脚本运行期间执行其他命令**，等脚本执行完毕再继续
- 脚本执行完后**必须检查结果**：
  ```bash
  cat {SKILL.md 所在目录}/assets/jean-token
  ```
- 如果文件为空或不存在，说明获取失败（可能用户未完成登录就按了回车，或 cookie 读取失败），告知用户后进入路径 E

---

## 路径 E：用户手动提供 token（最终回退）

当以上所有自动方式均失败时，引导用户手动获取。告知用户以下步骤：

1. 在浏览器中打开 `https://jean.corp.elong.com/v3/access/#/plat` 并确保已登录
2. 按 F12 打开浏览器开发者工具
3. 切换到 Application（应用）标签页
4. 左侧找到 Cookies → `https://jean.corp.elong.com`
5. 找到名为 `jean_v2` 的 cookie，复制其**完整的值**
6. 将值粘贴发送给我

收到用户提供的 token 后，进入**写入缓存并验证**。

---

## 写入缓存并验证

无论通过哪条路径获取到 token，都通过脚本一步完成写入缓存 + 验证：

```bash
cd {SKILL.md 所在目录} && node --experimental-strip-types scripts/validate-token.ts --token "{获取到的token}"
```

脚本行为：验证 token 有效性，若验证通过则自动写入 `assets/jean-token` 缓存文件。

输出 JSON：
- `{ "valid": true, "token": "..." }` → 验证通过且已缓存，返回 SKILL.md 继续执行后续步骤（识别 appUk → 确认环境）
- `{ "valid": false, "reason": "..." }` → 验证失败，告知用户，建议尝试下一条路径或重新登录后再试
