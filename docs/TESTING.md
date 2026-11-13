# 测试组织与去重

测试按功能组织；`tests/` 只保存在本机，不提交 Git。应用的内部模拟数据标识和兼容启动参数仍可能包含 P1–P4，日常执行不再按阶段分组。

## 日常执行

```powershell
node scripts/check.mjs
node scripts/test.mjs --desktop
```

第一条只执行一次单元测试、类型检查和构建；第二条执行完整桌面计划。`pnpm smoke` 和 `pnpm smoke:desktop` 是第二条的别名，任选一个即可。

```powershell
node scripts/test.mjs --desktop --list
node scripts/test.mjs --desktop --suite=playback
node scripts/test.mjs --desktop --suite=layout --scale=1.25
node scripts/test.mjs --dev
```

套件名和比例去重后执行；未知选项会报错。开发模式仅验证导入与安全的首次启动和恢复。

## 桌面检查归属

| 功能 | 覆盖内容 | 默认启动次数 |
| --- | --- | ---: |
| import | 桥接接口与文件访问隔离、分享导入、封面、搜索、版本冲突、偏好保存及恢复 | 2 |
| account | 扫码状态、Windows 实际加密、完整同步、失败保留缓存、恢复与退出登录 | 2 |
| playback | 实际解码、版本按钮、队列、自然结束、持续播放、本地关联、缓存和恢复 | 2 |
| layout | 大曲库、三档缩放、两种主题及窗口尺寸、布局与键盘操作；基准档额外恢复 | 4 |

完整计划共 10 次启动。旧入口全部执行时需要 14 次（P0–P3 各两次，P4 三档各两次）。保留不同缩放下的几何检查；分类、排序、快捷键只在首个选定比例检查。播放连续性由 playback 负责，layout 播放生成音频以检查播放状态下的布局。

P0 的公共桥接、固定接口、非法载荷和文件协议检查并入 import 首次启动；实际加密及跨进程恢复并入 account；偏好控件及恢复并入 import；许可内容和键盘关闭并入 layout。删除旧的基础测试实现及六个重复调度脚本。

## 单元测试归属

| 文件 | 负责内容 |
| --- | --- |
| database.test.ts | 初始数据库升级、升级回滚、拒绝更新 schema、底层位置与账号隔离 |
| account.test.ts | 标准协议、分类、分页、登录同步、取消及账号事务 |
| adapters.test.ts | 分享解析、HTTP 跳转、元数据、资源头、请求重试及限流响应 |
| import-storage.test.ts | 分享导入事务、位置与搜索、持久化缓存及共享请求预算 |
| matching.test.ts | 固定曲目样本、候选排序、版本与时长边界、输出隐私 |
| covers.test.ts | 首曲封面身份及缓存失效 |
| player.test.ts | 队列、异步竞争、暂停、恢复上限、实际历史及账号切换 |
| media.test.ts | 媒体令牌、Range／HEAD、网络读取和完整缓存边界 |
| local-cache.test.ts | 本地文件变更、格式头、缓存完整性、切换目录及安全清理 |
| selection.test.ts | 试听、保存及恢复选择、显示、重排、重复曲目、同步和升级 |
| titles.test.ts | 扩展名清理、原始字段保留、导入调用链及历史匹配缓存修复 |
| ipc.test.ts | 音乐与播放 DTO、范围与字段限制、Vue 响应式载荷序列化 |
| security.test.ts | 来源、资源路径及偏好参数校验 |
| vault.test.ts | 加密替身、篡改检测、失败保留及异步写入顺序 |
| logging.test.ts | 日志白名单与隐私过滤 |
| test-plan.test.mjs | 调度去重、缩放及恢复覆盖，拒绝缺项、重复、陈旧和错误模式报告 |

本轮合并了两处重复：选择保存／重开数据库／恢复原版，与版本显示测试共用一次资料；分享重导入／修正元数据／替换歌曲不继承选择，归为同一场景。音乐与播放载荷检查集中到 ipc，减少跨文件重复维护。

以下相似测试保留，因为验证的条件不同：空绑定与已解析原版后的试听；不同 schema 的迁移；分享导入与账号同步的事务；乱序范围写入、截断响应与读取完成前取消；异步返回、播放地址失效与持续限流；纯参数校验、真实桥接调用及实际界面点击。单元加密替身不替代 Windows safeStorage，模拟播放器事件不替代 Chromium 实际解码。

## 生成文件与发行验证

生成文件统一位于 `.tmp/`。单元测试清理自己创建的资料；桌面成功运行清理该轮截图、模拟音频与数据库，只覆盖写入该模式的 `tests/latest-<mode>.json`。失败资料保留以供定位，`--keep-artifacts` 可保留成功资料。工具缓存、检查和审计分别位于 `cache/`、`checks/`、`audit/`。

发行程序重新构建及打包后执行 `node scripts/test.mjs --desktop --packaged`，再执行 `node scripts/audit-package.mjs --smoke`。审计核对同一份执行计划、测试协议、实际包哈希及安装包生成时间；子集测试或旧报告不能冒充完整发行验收。已有发行包不会因调整测试自动重打包。

安装验证仍单独执行，位于 `.tmp/install/`，调用统一布局套件并保留三份缩放资料，检查安装前后实际程序、注册项及卸载后资料保留。真实扫码、真实音频下载和本机诊断仍为手动工具，结果位于 `.tmp/manual/`，不在常规离线计划中执行。
