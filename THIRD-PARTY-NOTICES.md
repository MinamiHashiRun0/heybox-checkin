# Third-party notices

本项目由 AI 生成, 基于对下列既有实现**行为**的观察重写 (接口路径、请求参数、Cookie 格式、签名服务接口形状)。未逐行复制任何上游源码。

## 参考实现

| 项目 | 用途 | 许可 |
|---|---|---|
| [yowiv08/heybox](https://github.com/yowiv08/heybox) | 签到接口流程、hkey `mode=request` 接口形状、签名参数集合 | 仓库未声明许可 |
| [zpiz/scripts](https://github.com/zpiz/scripts) (`Egern/blackbox.js`) | 代理 App 双分支脚本结构 (cron + 抓包)、设备参数抓取思路 | 仓库未声明许可 |
| [wqe134/xiaoheihe-autosign](https://github.com/wqe134/xiaoheihe-autosign) | 同一签到链路的旁证 | 仓库未声明许可 |
| [chr233/Xiaoheihe_CSharp](https://github.com/chr233/Xiaoheihe_CSharp) | 确认 App 签名算法未公开 (其同样依赖外部 hkey 服务) | 见其仓库 |
| [chavyleung/scripts](https://github.com/chavyleung/scripts) | BoxJs / Env.js 的存储与接口契约 (用于核实宿主适配层写法) | MIT |

## 许可状况说明

上述参考实现中的多数**未声明任何开源许可**, 因此本项目无法继承其许可, 仅在此做来源署名。

若你是上述项目的作者并认为此处署名方式不妥, 请开 issue。

## 外部服务

本模块不包含签名算法, 运行时依赖外部 hkey 签名服务:

- 默认: `https://hkey.qcciii.com/hkey` (第三方运营, 非本项目所有)
- 该服务收到 `heybox_id` / `imei` / `path` / `time`, 不收到 Cookie
- 该服务的可用性、稳定性与隐私策略均不由本项目控制

## Surge

本项目依赖 Surge 的脚本、MITM 与信息面板能力。Surge 为 Surge Networks Inc. 的商业软件, 与本项目无关联。
