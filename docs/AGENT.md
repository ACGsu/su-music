# Su Music 后续开发说明

本文是后续 agent 的项目入口。开始修改前阅读本文、[README.md](../README.md) 和相关源码；需求与约束以当前实现和用户最新指令为准。更新功能时同步维护本文及面向用户的说明。下文代码路径和命令均以项目根目录为基准。

## 当前基线

- 自用 Windows x64 音乐播放器，Electron + Vue + TypeScript，当前版本 `0.4.0-rc.1`，SQLite 迁移版本 **7**。
- V0 按当前酷狗账号核心范围接受；P0–P4 已在当前 Windows 11 x64 环境收尾。用户已人工接受正式程序的登录同步、界面、播放、版本选择、本地文件与缓存目录。
- 清理前有 81 项测试、编译版／交付版／隔离安装版共 18 次桌面回归、441 次布局检查，以及独立 NSIS 安装和卸载证据。历史报告、临时资料和 V0 验证器按用户要求删除，不要依赖旧报告作为脚本输入。
- 2026-11-12 整理 Git 工作区后重新完成 81 项测试、主进程／Vue 类型、构建及导入界面首次启动／重启回归。导入回归从本机 `tests/fixtures/` 的公开元数据生成模拟结果和封面，不依赖已删除的历史报告；该轮测试输出随后清理。
- 用户最新要求：发行目录按 `package.json` 的版本号命名，当前为 `release/0.4.0-rc.1/`，其中同时保存 NSIS 安装包、Portable EXE、`win-unpacked/Su Music.exe` 和说明。同一版本重新打包更新该目录；版本升级创建新版本目录，保留已有版本。
- 使用说明已合并至 `README.md`，源码与发行包都保留这一份说明；功能和版本变化时同步更新。
- Git 交付源码、必要工具脚本、构建配置、许可及说明；按用户要求，`tests/` 内的测试、固定样本及回归／诊断脚本仅保存在本机，不提交 Git。依赖、缓存、编译与发行产物属于本机生成内容。
- 开发说明与已知限制集中在 `docs/`，第三方声明与许可原文集中在 `licenses/`；根目录 `README.md` 提供入口。源码、应用内许可读取和发行包使用相同的文档路径，更新生成或打包脚本时不要恢复旧的根目录文档。

- P0–P4 开发测试已按功能归并。日常入口为 `scripts/test.mjs`，执行计划与发行审计共用 `scripts/test-plan.mjs`；覆盖归属见 [TESTING.md](TESTING.md)。不要恢复阶段入口或按阶段重复跑相同断言。

## 产品约束

1. **酷狗标准版账号，只读同步。** 支持真实扫码、手机确认、会话恢复以及默认、自建、收藏歌单读取。`我喜欢` 和 `默认收藏` 保留；收藏音乐专辑暂归“收藏歌单”，同时保留 `subtype=album`。未知分类显式提示，不用标题、位置或私人账号硬编码分类。
2. 同步先完整读取并核对目录、分页、曲目数和身份，再事务替换。失败、取消、会话失效、退出登录均保留上次成功的本机曲库。不要新增云端编辑或收藏增删请求。
3. 分享导入独立展示，相同全局标识可关联账号歌单。歌曲始终按**歌单与位置**保存；同曲、同 hash 的重复位置不得全局去重。
4. 播放优先级：相同录音与版本 → 完整稳定播放 → 320 kbps。找不到原版时提供替代选择、本地关联或明确的不可用状态。不能把搜索、元数据匹配、地址非空、局部资源读取当成完整播放通过。
5. 末尾 `.mp3`／`.flac`／`.wav` 等扩展名由 `track-name.ts` 整理。保留原始文件名、hash、raw_json 和曲名内部标点／版本标签，不把文件后缀带入显示与音源搜索。
6. 标题、歌手、版本标签一致且时长差不超过 2 秒的候选自动尝试播放；多候选优先同专辑，再按最接近时长和稳定 ID 选择。资料不足或版本冲突才需人工对照。
7. 已匹配或已选定的歌曲行右侧显示“播放”和“下一首播放”；其他行提供版本对照。选中行的上方操作保留更换版本、恢复原版和本地关联。
8. “选定并播放”保存本机选择，歌单及曲库搜索显示所选标题、歌手、专辑、时长与版本；“仅试听”仅改变本次播放。原收藏记录保留，同步、hash／元数据更新、重排和重启不得覆盖选择。重复位置独立对应，不把选择转给另一首歌。历史和正在播放显示实际版本。
9. **歌曲缓存位置可自选。** 原生目录选择使用专用缓存子目录；切换用于后续歌曲，当前资源保持，旧目录保留。完整缓存总上限 2 GB、单曲 512 MB；只有完整字节覆盖及有效头部才能复用，部分下载不能算完整缓存。清缓存保留正在使用的文件；移出本地列表保留原音频。
10. UI 沿用已验收的工业风昼夜配色：强调色 `#FFFA00`，黄底深色文字。网格封面完整显示，dock 左右边界与封面对齐，歌单名左侧、进入箭头右侧；列表用小封面横行。不要恢复独立示例页面。最小窗口 960×640；浏览、主题、队列／版本面板切换保持常驻音频与队列。

## 安全与运行边界

- 凭据只在主进程，以 Windows `safeStorage` 加密；正常资料目录为 `%APPDATA%\Su Music\`。不要把真实会话、二维码、账号快照、缓存、音频或日志提交 Git，也不要为清理／测试删除真实用户资料。
- electron-builder Portable 运行时使用 `PORTABLE_EXECUTABLE_DIR`／`PORTABLE_EXECUTABLE_FILE`，资料写入 EXE 旁的 `Data/`；不要使用指向临时解压目录的 `process.execPath` 计算便携资料位置。安装版仍使用 `%APPDATA%\Su Music\`。
- 软件更新只由设置页手动触发。主进程固定访问 `ACGsu/su-music` 的 GitHub Release，按当前安装版／Portable 形态选择精确命名的资产，并在执行前核对同名 `.sha256`；渲染器不能提交 URL、文件名或命令。正式版忽略预发布，预发布版可以继续接收预发布和正式版。
- `contextIsolation=true`、`sandbox=true`、`nodeIntegration=false`。只通过固定的 preload 接口通信；主进程核对发送 frame、受信任页面及 DTO 字段。不要引入任意 URL／路径／命令执行接口。
- Vue 响应式对象不能直接穿过 contextBridge。播放请求使用 `validatePlayerCommand` 构造固定字段的普通对象；回归必须实际点击版本按钮，不能只直调主进程绕过界面。
- GD 搜索、元数据补充、播放地址解析共享持久化预算 **45 次／5 分钟**。实时脚本也共用正常资料目录的 `gd-budget.sqlite`，不能另开预算规避限流。
- 酷狗凭据绝不发送 GD。公网地址由主进程按允许 host、协议及重定向核查。渲染器只接收临时 `su-music://media/<token>`，本地文件也只使用注册记录。
- 资源解析最多两次，有限重试；整条队列不可用必须停止，不能无限等待或循环。自然结束才记录完成，跳到尾部不算听完整首。
- 不因自动审批超时或拒绝换参数绕过审核。用户允许受阻的必要命令由其执行；先完成不受影响的工作，再给出具体命令和原因。
- 没有提交、推送或发布授权时，只修改与验证本机项目；不要自行提交／推送或恢复阶段性报告体系。

## 目录与关键代码

| 位置 | 职责 |
| --- | --- |
| `docs/` | 后续开发说明、已知限制及验收范围。 |
| `licenses/` | 第三方声明汇总及组件许可原文；汇总由 `scripts/audit-licenses.mjs` 生成。 |
| `src/main/index.ts` | 窗口、固定 IPC、协议、safeStorage、生命周期；测试 flag 只使用隔离资料。 |
| `src/main/database.ts` | 迁移、账号隔离曲库、候选缓存、版本绑定、显示覆盖、同步重排对应、历史与本地记录。 |
| `src/main/account/` | 标准版协议、QR、完整分页采集、会话及同步状态。 |
| `src/main/music/` | 分享解析、GD、预算、版本匹配、封面、资源头部、同步身份对应。 |
| `src/main/player/` | 队列控制、实际来源、临时媒体协议与范围请求、自选目录完整缓存、本地音频。 |
| `src/shared/` | 受限 DTO、校验、曲名整理及播放类型。 |
| `src/preload/index.ts` | 固定桥接接口。 |
| `src/renderer/App.vue` | 页面导航、歌单详情、选中行、设置与事件协调。 |
| `src/renderer/components/` | AudioBridge、PlayerBar、VersionPanel、QueuePanel、封面、搜索、本地／历史／待处理页。 |
| `src/renderer/style.css` | 全局主题、布局、密度及响应样式。 |
| `src/vendor/qrcode/` | 已固定的 QR 核心，保留许可证和来源；不包含网络或 CLI。 |
| `tests/` | 本机离线单元测试及公开元数据固定样本，整个目录被 Git 忽略。 |
| `tests/scripts/` | 本机桌面回归、安装验证、真实验证与诊断入口，随 `tests/` 一起忽略。 |
| `scripts/` | 依赖准备、类型与构建检查、打包、许可与发行审计，以及本机测试的统一入口。 |
| `scripts/release-paths.mjs` | 从 `package.json` 的版本号生成发行目录和可执行程序路径，供各脚本共用。 |

`collection_tracks` 保存原记录；显示通过 `presentTrack`／`getTrackPresentation` 叠加本机选择。`p3_bindings.chosen_by_user` 区分自动匹配与用户选择。`onCatalogChanged` 将对应位置通知播放器，不能在同步时重建正在使用的音频。

数据库更改新增迁移，保留 schema 7 及更早资料的升级路径；不要直接重建用户数据库。新增字段同步更新公共 DTO 与隐私过滤。

## 工具链与常用命令

固定 Node.js **24.19.0**、pnpm **11.22.0**、Electron **45.2.3**；其他精确版本见 `package.json` 与 `pnpm-lock.yaml`。不随意升级或引入依赖。

从项目根目录运行：

```powershell
pnpm install --frozen-lockfile --ignore-scripts
node scripts/prepare-electron.mjs
node scripts/audit-licenses.mjs
pnpm dev
```

安装生命周期脚本默认关闭。`prepare-electron.mjs` 使用 npm 包附带的 SHA-256 核对 Windows x64 ZIP，再解压到项目内依赖目录。`node:sqlite` 来自 Node／Electron，不另装数据库原生插件。

```powershell
node scripts/check.mjs
node scripts/package.mjs
node scripts/audit-package.mjs
```

- `scripts/check.mjs` 执行主进程类型、Vue 类型及构建；本机存在单元测试时先运行测试，缺少测试时明确记录跳过。`pnpm test`、`pnpm typecheck`、`pnpm build` 可单独使用；显式请求测试而缺少本机资料时会报错，不会误报通过。
- `pnpm smoke` 与 `pnpm smoke:desktop` 共用 `tests/scripts/desktop-smoke.mjs`，默认执行导入与安全、账号、播放、布局共 10 次启动；同一命令不重复调度套件。前三组分别首次启动／恢复；布局三档缩放首次启动、仅基准档额外检查恢复。
- `--suite=import,account,playback,layout` 选择功能，`--scale=1,1.25,1.5` 选择布局比例，`--list` 只显示计划。`--dev` 验证 Vite 开发模式的导入与安全；`--packaged` 验证重新构建的发行程序。旧程序未包含测试协议 2 时拒绝启动，不能将旧程序结果充作新测试通过。
- 测试脚本生成的临时资料和工具缓存集中在 `.tmp/`：`tests/` 为测试资料和最新摘要，`checks/` 为类型／构建日志，`cache/` 为工具缓存，`audit/` 为审计，`manual/` 为手动验证，`install/` 为隔离安装。成功的桌面运行自动清理自身资料，失败保留；`--keep-artifacts` 保留成功资料。只清理已核实处于这些目录内的生成内容，不清理正常用户资料。
- 打包输出 `release/<版本号>/`，electron-builder 使用 `release/${version}`，相关脚本使用 `release-paths.mjs`，升级时只需更新 `package.json` 版本号并同步说明。一次打包生成面向当前用户的 NSIS 和单文件 Portable，不自动发布。`audit-package.mjs` 比较编译产物／README、排除私人和测试文件，并为两种交付文件生成 SHA-256；GitHub Release 需要同时上传 EXE 与同名校验文件，`--smoke` 另外要求当前交付程序的回归结果。
- 安装检查另运行 `node tests/scripts/build-install-test.mjs`、`& '.\tests\scripts\validate-install.ps1'`。使用随机独立 appId／GUID、经检查的 `.tmp/install/installed-*` 目录，关闭快捷方式、自动运行和用户资料删除；安装后检查四次启动，卸载后核对注册项移除和测试资料保留。不要拿真实旧安装做清理测试。
- 当前开发机 Node 为 `D:\nodejs\node.exe`，pnpm 为 `D:\nodejs\node_global\pnpm.cmd`。如果 pnpm 自动检查要求重建依赖但安装条件不具备，可用 `node scripts/check.mjs` 调用现有固定依赖；不要自动清空 `node_modules`。
- Windows 沙箱 ACL 曾阻止 Chromium 读 Electron 目录。需要正常权限时走审批，不关闭 Electron sandbox、不随意改 ACL。桌面截图用生成资料检查，物理声音与原生选择界面的实际观察由用户确认。

## 脚本职责与保留范围

`scripts/` 中保留以下 9 个可随 Git 提交的通用入口，均不自动发布：

| 文件 | 作用 |
| --- | --- |
| `prepare-electron.mjs` | 下载固定版本 Electron、核对 SHA-256，再调用解压助手。 |
| `extract-electron.ps1` | 检查路径位于工作区后解压运行时，由准备脚本调用。 |
| `check.mjs` | 类型检查与构建，本机有单元测试时一并执行；结果写 `.tmp/checks/`。 |
| `test.mjs` | `pnpm test`、`pnpm smoke`、`pnpm smoke:desktop` 的统一入口；缺少本机测试资料时明确报错。 |
| `package.mjs` | 校验构建、许可和运行时后生成 Windows x64 NSIS 安装包及 Portable EXE。 |
| `release-paths.mjs` | 从版本号计算发行路径，供打包、审计和本机脚本共用。 |
| `test-plan.mjs` | 共用功能执行计划及结果校验，防止遗漏、重复和旧报告被发行审计接受。 |
| `audit-licenses.mjs` | 读取已安装依赖许可，生成 `licenses/THIRD_PARTY_NOTICES.md` 及本机审计结果。 |
| `audit-package.mjs` | 比对 ASAR、源码文档和构建，检查排除项，整理发行说明与许可并写 SHA-256；可附加核对回归及安装证据。 |

以下 9 个本机工具位于 `tests/scripts/`，不提交 Git：

| 文件 | 作用 |
| --- | --- |
| `desktop-smoke.mjs` | 统一调度导入与安全、账号、播放和布局；支持编译、开发、发行及隔离安装模式。 |
| `import-fixture.mjs` | 从两个固定公开样本生成导入测试输入和封面。 |
| `test-workspace.mjs` | 核对路径后清理本轮生成的测试资料。 |
| `build-install-test.mjs` | 创建独立应用标识和无快捷方式的安装测试包。 |
| `validate-install.ps1` | 安装隔离包、执行布局首次启动／恢复检查、卸载并核对注册项和测试资料。 |
| `p2-live.mjs` | 在隔离资料下手动验证真实扫码。 |
| `p3-real-audio.mjs` | 验证一首公开 Carefree 的真实完整播放，使用共享请求预算。 |
| `p3-cache-probe.mjs` | 验证真实下载完成与取消读取的缓存边界。 |
| `diagnose-playback.mjs` | 只读汇总本机播放错误和请求额度。 |

源程序中的 `import-smoke.ts`、`account-smoke.ts`、`playback-smoke.ts`、`layout-smoke.ts` 是相应桌面检查实现；公共桥接与协议检查由 `desktop-security.ts` 负责，只在导入首次启动时运行。现有内部启动参数及模拟数据标识兼容保留，不代表独立阶段测试。

## 真实验证与已知边界

真实网络检查与离线回归分开，仅在需求或新风险需要时执行。`tests/scripts/` 下的 `p2-live.mjs`、`p3-real-audio.mjs`、`p3-cache-probe.mjs` 是明确的实时入口；`diagnose-playback.mjs` 只读正常资料的近期问题，不读取凭据。执行前确认范围，结果留在忽略目录。

历史摘要：当前账号 10 项／955 个位置及取消、重新收藏核对通过；公开 22 首样本有 21 首元数据匹配、1 首存在时长冲突，19 首已有局部资源证据；Carefree 一首自然播放约 205.079 秒，并有 8,205,627 字节 MP3／320 kbps 完整缓存证据。没有全曲库、全部 VIP 或长期稳定性的证明。公开测试样本不含私人账号会话。

Windows 10、其他机器、ARM64、跨显示器移动和正式旧安装覆盖未实测。100%／125%／150% 检查采用 Chromium 设备比例，未改变系统全局设置。普通他人收藏歌单子类型、服务端二维码自然过期及长期会话仍有边界。用户免除两处 hash 变化原因复测，不恢复旧二维码老化脚本。

QQ／网易云账号登录、云端编辑、歌词同步、批量下载和多设备同步不属于当前功能。更新仅由用户手动检查 GitHub Release，并在明确点击后下载和应用。完整限制见 [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)。许可见 [第三方声明](../licenses/THIRD_PARTY_NOTICES.md)、`licenses/` 及 QR 来源记录；GD 服务出处与非商业使用条件必须保留。
