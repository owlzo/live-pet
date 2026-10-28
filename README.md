# live-pet

抖音直播间桌面陪伴宠物：透明置顶小窗 + 百余段动画 + 拖拽物理 + 弹幕互动 + 大模型对话。
Windows 单进程 Electron 应用，带一个全宽 Web 控制台。

> ⚠️ **素材版权**：`assets/webm`、`assets/memes`、`assets/fonts` 来自上游项目，**禁止商用**。
> 正式开播前必须替换为自制素材，详见 [DISCLAIMER.md](DISCLAIMER.md)。

## 特性

- **桌面宠物**：透明置顶窗口、点击穿透、托盘常驻、多屏 DPI 自适应、多开
- **动画系统**：106 段 VP9-alpha 透明动画，待机/转向/拖拽/点击/移动/事件六类动画池，权重可调
- **物理手感**：重力、弹性、地面摩擦、抛掷力度、顶部反弹、宠物互撞
- **直播互动**：抖音弹幕 → 气泡/动作；**单机模式**（只读弹幕，不走模型）与 **AI 模式**（弹幕交给大模型）一键切换
- **重复抑制**：同一用户 + 同一内容在时间窗内限次放行，礼物同规则、不合并
- **Web 控制台**：概览 / 宠物 / 外观与物理 / AI 对话 / 直播接入，左侧导航 + 全宽卡片网格
- **大模型**：OpenAI 兼容（DeepSeek 默认）与 Anthropic；余额查询复用同一把 DeepSeek 密钥

## 环境要求

| 项 | 版本 |
|---|---|
| Node.js | ≥ 22.12 |
| Electron | 自带或用本机已有的（见下） |
| 平台 | Windows 10/11（macOS / Linux 未验证） |

## 快速开始

```bash
npm install
npm run build          # tsdown → lib；shared-core → runtime；类型声明 → lib/types
npm run start:app      # 启动桌面宠物
```

首次运行需要一份 Electron。已有就直接指过去：

```powershell
$env:LIVE_PET_ELECTRON_PATH="C:\Users\<你>\.dsh\electron\electron.exe"
npm run start:app
```

没有则 `npm run ensure:electron` 下载一份（约 104 MB，落在 `~/.live-pet/electron`）。

启动日志第二行是控制台地址：

```
[live-pet-app] 本机服务 http://127.0.0.1:18080
[live-pet-app] 控制台 http://127.0.0.1:18080/console/
```

> 端口默认随机；转发器需要固定地址时设 `LIVE_PET_PORT=18080`。

## 目录结构

```
src/
  app/          单进程 Electron 应用：本机 HTTP 服务 + 宿主装配 + 桌面窗口
  host/         宿主半侧：配置、路由、余额、碎碎念、对话、桌面 Helper 生命周期
  live/         直播接入：事件模型、去重、动作映射、WS 源、HTTP 注入
  shared/       纯逻辑（物理 / 菜单 / 拾取权重），宿主与渲染端共用
  standalone/   本机 AI 设置（OpenAI 兼容 / Anthropic）与请求边界
  console/      Web 控制台（HTML / CSS / 原生 JS，无构建链）
runtime/
  electron-helper/  桌面壳：透明置顶窗、点击穿透、托盘、多屏 DPI、sprite 渲染
assets/
  webm/         透明动画（VP9-alpha）
  memes/        表情包
  fonts/        气泡字体
  sound/        点击音效
  config.jsonc  默认配置
scripts/        构建、打包、控制台探针
```

## 配置

用户配置：`~/.live-pet/live-pet/main-config.jsonc`（JSONC，可写注释）。
默认值在 `assets/config.jsonc`，字段含义见该文件注释。

三层结构：

- **实例级**（`pets[]`）：名字、大小、位置、显示位置、余额/碎碎念开关、人设
- **全局**：物理、字体、表情包开关、记忆轮数、模型
- **条目级**：动画池、权重、事件档位

保存后桌面窗口会自动按新配置重建，无需重启应用。

## 控制台

`http://127.0.0.1:<端口>/console/`，或右键桌宠 →「打开控制台」（带令牌）。

| 页签 | 内容 |
|---|---|
| 概览 | 宠物数、表情包、模型、直播状态、托盘；快速操作（说话 / 播动画 / 刷新余额 / 重载配置） |
| 宠物 | 多开增删、显示名、大小、位置、角落、边距、四个开关、独立人设 |
| 外观与物理 | 重力 / 弹性 / 摩擦 / 抛掷力度 / 顶部反弹 / 宠物互撞；字体与字号；全局开关 |
| AI 对话 | 协议、地址、模型、密钥（可清除）、启用、记忆轮数、配图上限、输出上限、碎碎念间隔、测试连接 |
| 直播接入 | 模式（单机 / AI）、房间号、转发地址、去重参数、自动连接、运行状态、模拟事件 |

**权限**：同源页面（`sec-fetch-site: same-origin`）读写放行；跨站一律 403；其它本机进程需带令牌。

## 直播接入

### 路线 A · 直连采集器（最省事）

```bash
git clone --depth 1 https://github.com/jwwsjlm/douyinLive.git
cd douyinLive && go build -o douyinLive ./cmd/main && cd ..
./douyinLive          # 默认 ws://127.0.0.1:1088/ws/<房间号>
```

控制台源地址填 `ws://127.0.0.1:1088/ws/{room}`，房间号填抖音直播间号。

### 路线 B · 经 cyber-xiaoya-danmaku 中转（多平台）

```
douyinLive(:1089) ─┐
B站 / YouTube / 视频号 ─┴─▶ cyber-xiaoya-danmaku(reader.py) ──POST──▶ live-pet
                                                              /live-pet/live/ingest
```

1. 启动前设 `LIVE_PET_PORT=18080` 固定端口
2. 在它的 `config.json` 里把 `dh_url` 指向 `http://127.0.0.1:18080/live-pet/live/ingest`
3. `douyin.ws_base` 指向采集器（它默认用 **1089**，与路线 A 的 1088 不同）

注入端点接受原样 JSON：

```json
{"nick":"观众A","content":"主播好","platform":"抖音","text":"主播好"}
{"nick":"观众B","kind":"gift","gift_item":"小心心","gift_num":3}
```

> cyber-xiaoya-danmaku 是 **AGPL-3.0**：本项目只通过网络调用、不修改其代码，请作为「用户自行安装的外部进程」使用，
> 不要打包进发布产物。它自身会做去重与连击合并；若觉得去重太严，把「窗口内最多放行」调大。

### 两种模式

| 模式 | 弹幕 | 礼物 | 进场 / 关注 / 点赞 |
|---|---|---|---|
| `readonly` 单机（默认） | 气泡显示「用户：内容」，**不走大模型** | 固定话术感谢 + 点击动画 | 只记日志 |
| `ai` | 交给大模型生成回复 | 固定话术感谢 + 点击动画 | 欢迎语 / 感谢关注 / 动画 |

**去重口径**：不做同类合并，只抑制重复——同一用户 + 同一内容在窗口内（默认 30 秒）最多放行 3 次，
超出丢弃并计入「抑制」；礼物按「用户 + 礼物名」同规则。

## HTTP 接口

前缀 `/live-pet`，只监听 `127.0.0.1`：

| 接口 | 说明 |
|---|---|
| `GET /config` | 读合并后的成品配置 |
| `PUT /config` | 保存用户层配置（白名单重建） |
| `GET /state` | 轮询快照（长轮询 `?since=&timeout=`） |
| `POST /broadcast?pet=<id>&surface=any` | 让它说一句话 `{text}` |
| `POST /anim?pet=<id>&surface=any` | 播指定动画 `{name}` |
| `POST /throw?pet=<id>` | 抛掷 `{angle,power}` |
| `POST /balance` | 刷新余额（DeepSeek） |
| `POST /reload` | 按当前配置重建桌面窗口 |
| `GET /live/status` | 直播连接状态与 收到/放行/抑制 计数 |
| `GET\|POST /live/config` | 读写直播配置 |
| `POST /live/connect` / `POST /live/disconnect` | 连接 / 断开 |
| `POST /live/test` | 注入测试事件 `{kind,user,text?,giftName?}` |
| `POST /live/ingest` | 外部转发器入口（本机无 Origin 请求免令牌） |

## 余额

「查看余额」默认查 DeepSeek 官方接口（`GET /user/balance`），密钥复用「AI 对话」里配置的那一份：

- `baseUrl` 含 `deepseek` + 已保存密钥 → 自动走 `deepseek-official`
- 其它服务商 → 余额功能明确不可用（各家没有统一接口）
- 周期刷新在 `eventsRefreshSec.balance`（默认 1800 秒），`pets[].balanceEnabled` 控制启用

## 开发

```bash
npm run typecheck        # tsc --noEmit
npm test                 # node:test（1174 项）
npm run probe:console    # 控制台冒烟探针（需 LIVE_PET_ELECTRON_PATH）
npm run dist             # electron-builder 打包
```

**控制台改动必须跑探针**：控制台是单文件内联脚本，语法错误会让整页静默变白，而接口全是 200，
只有探针能发现。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 控制台空白 | 前端脚本报错或浏览器缓存；`Ctrl+F5`，再跑 `npm run probe:console` |
| 找不到 Electron | 设 `LIVE_PET_ELECTRON_PATH`，或 `npm run ensure:electron` |
| 端口被占用 | 固定端口失败会回落随机端口，日志会写一条；转发器需同步改地址 |
| 余额不可用 | 只支持 DeepSeek 官方接口；检查 `baseUrl` 是否含 `deepseek` 且密钥已保存 |
| 弹幕收不到 | 确认采集器在跑、房间号正确、控制台状态为「已连接」；看 `~/.live-pet/live-pet/logs.txt` |

## 许可与免责

- **代码**：[MIT](LICENSE)
- **素材**：版权归原作者，**禁止商用**，详见 [DISCLAIMER.md](DISCLAIMER.md)
- **免责**：本项目仅供学习与个人直播辅助，使用第三方弹幕工具及由此产生的平台合规风险由使用者自行承担

## 致谢

- [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)：本项目的前身（桌面壳、动画链、物理与素材管线）
- [jwwsjlm/douyinLive](https://github.com/jwwsjlm/douyinLive)：抖音弹幕采集服务（MIT）
- [cyber-xiaoya/cyber-xiaoya-danmaku](https://github.com/cyber-xiaoya/cyber-xiaoya-danmaku)：多平台弹幕中间件（AGPL-3.0，未打包）
