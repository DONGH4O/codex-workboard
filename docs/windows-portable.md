# Windows x64 目录版运行与数据说明

## 支持边界

Windows 目录包生成后位于 `dist/win-unpacked`。该目录包已经在系统卷隔离目录完成真实离线 start/status/stop、非空重启、备份恢复和恢复目录启动读回，并已从 staging 零参数直接启动，证明运行不依赖 source 控制器；验收机上的 source 物理仍存在且未删除或改名。物理界面与用户接受仍待单独验收。该目录包是未签名的本地构建，不是正式发行版，也不是安装程序。它不包含 Codex CLI；使用真实 Codex 功能前，必须显式设置原生可执行文件 `CODEX_CLI_PATH` 和对应 `CODEX_HOME`。当前唯一固定支持版本为 `codex-cli 0.151.0-alpha.7.2`，其他版本会被预检拒绝；仅安装 Codex 桌面应用不证明独立 Workboard 已获得可用驱动或登录状态。不要把目录包、自动测试通过或本机运行等同于 GitHub Release、正式安装或人工界面验收。

NSIS 配置已经存在，但 `dist:win` 不属于目录包验收命令。卸载配置默认保留 Workboard 用户数据。

## 构建与检查

```powershell
npm.cmd run pack:win
npm.cmd run verify:win-package
```

`verify:win-package` 检查产品可执行文件、`app.asar` 中的主进程、preload、渲染器入口，并拒绝随包捆绑 `codex.exe`。

## 可逆运行

始终为数据和运行状态选择源码目录之外的独立绝对路径：

```powershell
npm.cmd run workboard:start -- --exe="F:\Portable\Codex Workboard.exe" --data-dir="F:\WorkboardData\acceptance" --state-dir="F:\WorkboardState\acceptance"
npm.cmd run workboard:status -- --state-dir="F:\WorkboardState\acceptance"
npm.cmd run workboard:stop -- --state-dir="F:\WorkboardState\acceptance"
```

状态记录绑定运行编号、进程编号、操作系统进程创建时间、规范化可执行文件路径、数据目录和控制管道。停止先请求该实例正常退出；只有完整身份再次匹配时才会终止该确切进程树，不按进程名称批量结束。身份不匹配时会拒绝操作。

默认 Windows 数据目录为 `%APPDATA%\Codex Workboard`。开发、测试和恢复演练应显式使用 `WORKBOARD_USER_DATA_DIR`，不要使用正式默认目录。数据目录包含 `taskboard.sqlite`、可能存在的 `taskboard.sqlite-wal` 与 `taskboard.sqlite-shm`，以及 `attachments`。`.runtime` 是瞬时锁目录，不属于备份。

## 备份与恢复

先通过 `workboard:stop` 正常停止目录版。应用、每日维护与备份共用独占数据访问闸门；仍有写入者时备份会拒绝执行。

```powershell
npm.cmd run data:backup -- "F:\WorkboardData\acceptance" "F:\WorkboardBackups\acceptance-01"
npm.cmd run data:restore -- "F:\WorkboardBackups\acceptance-01" "F:\WorkboardData\restored-01"
```

备份目标和恢复目标必须尚不存在、位于源码目录之外；恢复永不覆盖源数据目录。备份复制完整持久数据目录，包括存在时的 WAL、SHM 和附件；当前精确排除 `.runtime`、`.env`、`credentials`、`credentials.json`、`debug.log`、`logs` 以及扩展名为 `.log` 的项目。清单只保存相对路径、类型与大小。备份复制完成后验证备份副本；恢复前再次验证备份，恢复后验证新目录。验证覆盖 SQLite 完整性、核心表、任务—执行—审计关系、关键动作顺序、分类汇总和附件可读性。

恢复演练应使用第二个隔离目录启动目录包，再核对任务数量、泳道、分类、执行记录、审计动作和附件。2026-09-02 的系统卷隔离验收已完成这一自动链路；物理界面检查仍属于单独授权的人工验收。
