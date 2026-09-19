# 小黑盒签到 for Surge

> **本仓库代码由 AI 生成。** 基于对多个既有小黑盒自动化实现的行为观察重写, 未逐行复制任何上游代码; 详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

**当前版本: v1.0.0**

小黑盒 (xiaoheihe) 每日签到。Surge 模块形态, 通过 MITM 抓包自动录入账号, 由 cron 定时签到, 已签到自动跳过。

| | |
|---|---|
| 产物 | `heybox.sgmodule` + `heybox.js` |
| 平台 | iOS (Surge 4.9.3+ / 面板需有效订阅) |
| 需要 | MITM 已开启并信任证书 |
| 外部依赖 | 第三方 hkey 签名服务 (默认 `https://hkey.qcciii.com/hkey`) |

---

## 为什么需要第三方服务

小黑盒的签到接口 `/task/sign_v3/sign` 需要 App 签名参数 `hkey`, 该算法未公开。已核查的三个既有实现全部依赖外部签名服务:

- `yowiv08/heybox` → `https://hkey.qcciii.com/hkey`
- `zpiz/scripts`、`wqe134/xiaoheihe-autosign` → `http://47.120.39.109:9900/hkey`
- 逆向工程实现 `chr233/Xiaoheihe_CSharp` 同样抛 `HkeyServerErrorException`, 仓库内附带 `doc/hkey server.7z`

**本模块默认使用 qcciii 的 HTTPS 服务**, 而非明文 HTTP 的裸 IP 服务。该服务只会收到 `heybox_id` / `imei` / `path` / `time`, **不会收到 Cookie**。

想换成自建服务: 在 Surge 的持久化存储里写入 `HEYBOX_HKEY_API` 键即可覆盖。注意两个服务的接口形状不同 (本模块实现的是 `mode=request&path=` 形式), 换服务需要改适配代码, 不是只换 URL。

---

## 安装

1. 安装模块:

   ```
   https://raw.githubusercontent.com/MinamiHashiRun0/heybox-checkin/main/heybox.sgmodule
   ```

2. 确认 Surge 的 **MITM 已开启**、**CA 证书已安装并在系统里信任**。
3. 打开小黑盒 App, 随便划两下 (进任意页面即可)。模块会抓到请求并把账号写入存储, 收到一条 `已录入账号 <黑盒ID>` 的通知。
4. 在 Surge 的**策略选择页**查看 `小黑盒签到` 面板, 确认版本号与账号状态。

### 手动签到一次

Surge 里长按 `heyboxSign` 脚本即可立即运行 (Surge Mac 从 UI 运行)。

### 多账号

在小黑盒 App 里切换到下一个账号并划两下即可, 会自动追加。账号之间用 `&` 分隔存储。

---

## 配置

### 签到时间

默认每天 08:00。改 `heybox.sgmodule` 里 `heyboxSign` 那行的 `cronexp`:

```
heyboxSign = type=cron,cronexp="0 8 * * *",wake-system=true,timeout=60,script-path=...
```

- `wake-system=true` (iOS): 到点前先发一条静默本地通知把 Surge 唤醒。**不加它, Surge 被系统挂起时这个时间点会直接错过。**
- `timeout=60`: **cron 脚本默认超时只有 5 秒**, 签到要串行发 3~4 个请求, 必须显式放大。所有 Surge 超时单位都是**秒**。
- 改完模块后请同步把 `script-path` 的 `?v=1.0.0` 改掉 (见下)。

### 存储键

| 键 | 内容 |
|---|---|
| `HEYBOX_ACCOUNTS` | `heybox_id#pkey=..;x_xhh_tokenid=..`, 多账号 `&` 分隔 |
| `HEYBOX_DEVICE` | 抓包得到的设备参数 JSON |
| `HEYBOX_STATE` | 最近一次运行结果 JSON (面板读取) |
| `HEYBOX_HKEY_API` | 可选, 覆盖默认 hkey 服务地址 |

### 录完之后可以关掉抓包

账号录入是一次性的。之后可以把 `heyboxCapture` 那一行和 `[MITM]` 段删掉 (或禁用), 这样小黑盒的所有请求就不再被拦截, 省掉每次请求的脚本开销。

---

## 更新版本

Surge 对远程脚本有缓存, `script-update-interval` 默认 **86400 秒 (24 小时)**。所以 push 了新版本后, 已安装的模块不会立刻生效。

本仓库的约定: **版本号同时写在 `heybox.sgmodule` 的 `#!name`/`#!desc`、`heybox.js` 的头部注释、以及脚本内的 `VERSION` 常量里, 并且 `script-path` 带 `?v=` 查询串。**

升级步骤: 把三条 `script-path` 里的 `?v=1.0.0` 改成新版本号, 或重新安装模块。改完可以在面板标题上看到实际加载的版本号, 用来确认新版本真的生效了 (而不是命中了缓存)。

---

## 行为说明

每个账号独立处理, 互不影响:

1. 先查 `/task/sign_v3/get_sign_state`
2. **判定为已签到 → 直接跳过, 不发签到请求**
3. 未签到 → 调 `/task/sign_v3/sign`, 等待结算后复查 `get_sign_state`, 取 `sign_in_coin` / `sign_in_exp` / `sign_in_streak`
4. 再查 `/task/list_v2/` 取昵称与 H 币总数
5. 汇总写存储 + 发通知

判定顺序是**先查状态再决定签不签**, 而不是先签再看结果。这样重复触发 (含手动长按) 不会重复发签到请求。

### 判定枚举的待核对项

已签到的状态枚举集中在 `heybox.js` 的 `SIGNED_STATES` 里, 当前取值 `["ok", "finish", "ignore"]`, 来源是既有实现。

**这一项尚未用真实抓包核对。** 待核对内容: 已签到场景下 `get_sign_state` 返回的 `state` 到底取哪些值, 以及此时 `sign_in_*` 字段是否仍然存在。核对前请以面板显示的结果为准。

### 预查失败时的行为

如果状态预查请求失败, 脚本会**继续执行签到**而不是跳过。这是刻意选的失败方向: 已签到时重复调用签到接口只会返回 `ignore`, 不会造成重复签到; 反过来若因预查失败而跳过, 就会漏签。

---

## 明确不支持

分享帖子 / 分享游戏详情 / 分享游戏评价 / 发帖 / 游戏榜单停留。这些任务需要走 `data_report` 的 AES-CBC + RSA 加密上报, 在 Surge 的 JSC 里实现成本很高, 且与"定时签到"的目标无关。

## 已知限制

- **iOS only**。`wake-system` 是 iOS 专有参数。Mac 用户请删掉 `wake-system=true` (未在 Mac 上验证过)。
- **`HEYBOX_DEVICE` 是全局的**, 后抓到的设备参数会覆盖先前的。同一台设备多账号没问题; 两台设备混用会互相覆盖。
- **设备参数优先用抓包值**, 抓不到 `imei` 时回落到固定值 `4187fb55b1be198a`。
- 平台接口可能变动。既有实现都在跟版本, 本模块同样需要跟进。

## 本地自测

脚本可在 Node 下以 dry-run 方式运行: 会真实请求 hkey 服务以验证签名接口, 但**不会向小黑盒发送任何请求**。

```bash
HEYBOX_ACCOUNTS='123456#pkey=x;x_xhh_tokenid=y' node heybox.js --dry-run
```

## 免责声明

仅供学习交流。请自行承担使用风险, 并遵守小黑盒平台规则。Cookie 属于敏感信息, 不要泄露给他人或提交到公开仓库。

## License

MIT, 见 [LICENSE](LICENSE)。
