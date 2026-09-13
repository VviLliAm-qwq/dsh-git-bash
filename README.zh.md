# dsh-git-bash

**中文** · [English](README.md)

让 **Git for Windows** 的 `bash` 在 dsh 宿主进程里能被解析到，从而让官方 bash shell 工具栈在 Windows 上跑起来。

## 它解决什么问题

dsh 带两套 shell 栈，并按平台互相门控：Windows 下 `@deepseek-ai/dsh-base` 挂 `pwsh-sandbox` + `tool-pwsh`，同时把 `bash-sandbox` + `tool-bash` 关掉。关掉 bash 栈**不是因为不支持**，而是因为它 spawn 的是**裸名字 `bash`**：

- 执行器跑的是 `["bash", "-c", command]`；
- 沙箱层为受限运行器**自己又拼了一份** `["bash", "-c", command]`。

这两处都不接受"可配置的可执行文件路径"。而 Windows 默认 PATH 里没有 `bash`：Git for Windows 只把 `cmd\git.exe` 放进 PATH，不含 `bin\bash.exe`。所以能同时覆盖这两个 spawn 点的唯一接缝就是**进程 PATH**——本插件改的就是它。

## 它做什么

只在 `win32` 上，在 `apply()` 期间：

1. 探测 Git 安装位置（`%ProgramFiles%\Git\bin`、`%ProgramFiles(x86)%\Git\bin`、`%LOCALAPPDATA%\Programs\Git\bin`，最后 `C:\Program Files\Git\bin`），并确认里面**真的有** `bash.exe`；
2. 把该目录**前置**进 `process.env.PATH`——仅在 `bash` 尚不可解析时动手，且从不重排已有条目；
3. 把决定写进 `~/.dsh-tui/dsh-git-bash.log`（有上限：超过 128 KiB 丢旧的一半；`node --test` 下不写文件）；
4. 卸载时还原原 PATH——但只在**该值仍是自己设的那个**时才还原，别人之后改过的 PATH 一律不动。

其他平台只记一行 `skipped: not win32`，什么都不做。

它永不抛异常：没装 Git、日志写不了、配置是垃圾——宿主都保持原样。

## 启用 bash 栈：插件自带的 bundle patch 两件一起做

插件本身不能注册工具，只能把官方工具需要的环境准备好。所以**本包自己的 bundle patch 把两件事一起做了**——装上这个包就是全部安装步骤：

```yaml
- insert:
    - id: dsh-git-bash
      name: 'dsh-git-bash'
- id: bash-sandbox      # 开（config 原样回填：patch 会整体替换它）
  disabled: false
- id: pwsh-sandbox      # 关
  disabled: true
- id: tool-bash         # 开 → 出现 `bash` 工具
  disabled: false
- id: tool-pwsh         # 关
  disabled: true
```

两套栈都提供 `ctx.shell`，所以只能挂一个：这是**换栈**不是叠加。需要 PowerShell 时仍可从 bash 里调（`powershell -Command '…'`）。

**回滚 = 卸载这个包**（`dsh plugin --profile <p> remove dsh-git-bash`）：上面所有覆盖随包一起消失，`@deepseek-ai/dsh-base` 的平台门控重新生效。

> **不要把这段换栈放进"活着的" profile 自己的 `cordis.patch.yml`。** 那个文件被 `patchReload: live` 监视，一改就**立刻重配运行中的会话**——而那时本插件的行还没加载，于是那些会话的 shell 栈连 `bash` 都 spawn 不到。bundle patch 是启动时读取的，顺序才是对的。

## 安装

```sh
dsh plugin --profile dsh-tui add file:/到本仓库的绝对路径/dsh-git-bash
```

之后在 TUI 内 `/restart`，并在信任它之前先验证组合：

```sh
dsh --profile dsh-tui --dump-config    # 只组合插件树，不启动界面
```

## 配置

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `gitBinDir` | string | `""` | 存放 `bash.exe` 的目录。留空 = 自动探测。一旦设置它就是**唯一**候选——写错会如实报告，而不是被"兜住"。 |

探测不到时可以在这行上指定：

```yaml
- id: dsh-git-bash
  config:
    gitBinDir: 'D:\PortableGit\bin'
```

## 已知限制

- **这等于启用了官方按平台关掉的栈。** dsh 有意在 Windows 上禁用 bash 行；本插件去掉了它跑不起来的原因，但这条组合并非上游测试覆盖的路径。请保留 `cordis.patch.yml` 的 `.bak`：回滚就是删掉上面那四行覆盖。
- **沙箱模式是未验证的部分。** `danger-full-access` 下执行器完全跳过受限包装，这是实测过的路径；`workspace-write` 下沙箱层会把命令交给 Windows ACL 受限令牌运行器——那条路是为 POSIX 写的。请把受限模式当作未经验证。
- 插件不能新增工具，只能把官方工具需要的环境准备好。若没有启用 bash 行，本插件不会带来任何可见变化。
- 它改的是宿主进程内**进程级**的 PATH，这正是目的：所有解析 `bash` 的消费者（包括代理自己的命令）都受益。

## 开发与验证

```sh
pnpm install
pnpm test              # node:test 单测（纯探测 / PATH 规则）
pnpm check:encoding    # 无 UTF-8 BOM / 编码损坏 / tab 缩进
pnpm verify            # 以上两项依次执行
```

测试全是纯函数且可注入：`resolveBinDir` 的环境与"存在性探针"都从参数传入，所以探测规则能在不碰本机的前提下钉死。win32 的用例在有真实安装时跑真机、没有则跳过。

## 诊断

`~/.dsh-tui/dsh-git-bash.log` 每个决定一行：探测到的目录、`already resolvable`、`PATH left unchanged`、卸载时的还原（或 `PATH left alone: it changed after this plugin`）。每条消息同时送宿主 logger。

## 发布

- **仓库**：<https://github.com/VviLliAm-qwq/dsh-git-bash>（公开）

## 许可

MIT。
