# 只读根目录 `readRoots`

状态：**已实现**
关联：[agent §4.2](../specs/agent-architecture.md)（只读根）、§4.1（沙箱 allowRead）、§3.6（技能根）、§2.5（global → scope 合并）、[cli-ui §9.5](../specs/cli-ui.md)（`ea config read-roots`）、[gateway §4.2/§7](../specs/gateway-architecture.md)（按通道配置）

> 用一句话概括：`readRoots` 给会话加一组**可读、可作 cwd 运行、但不可写、且 agent 的文件工具够不着**的目录——和技能目录完全同一条边界通道。典型用途：把配置目录（如 `~/.enterprise-agent`）暴露给会话内的子进程，而**不**把它纳入可写工作区。

---

## 1. 为什么需要它

会话的文件边界（agent §4）默认只有一个**可写根** `rootPaths`（= `workingDir`，或默认工作目录 / 会话 scratch）。如果想让会话"看得到"工作区以外的目录（例如读配置），把它塞进 `workingDir` 会让该目录**变成可写**——配置、密钥引用、其他会话的 transcript 都可能被改写。

技能目录（agent §3.6）早就解决了这个问题：它在一条**只读 + 可运行、绝不可写**的通道上——子进程能读、能 `cd` 进去跑脚本，但落盘只能写回工作区。`readRoots` 把这条通道开放成**可配置**项，让你按需挂任意只读目录。

## 2. 边界语义

对 `readRoots` 里的每个目录：

| 能力 | 是否允许 | 机制 |
|---|---|---|
| 子进程读取（`exec` 跑的命令/脚本读文件） | ✅ | 沙箱 `allowRead` = `rootPaths ∪ skillRoots ∪ readRoots`（landstrip） |
| 作为 `runCommand` / `runScript` 的 `cwd` | ✅ | `resolveCwd` 白名单含 `readRoots` |
| 写入（任何工具或子进程落盘） | ❌ | 沙箱 `allowWrite` **只有** `rootPaths` |
| agent 的 `readFile` / `listDir` / `writeFile` | ❌ | 文件工具的 `guardPath` 只认 `rootPaths` |

> 注意第 4 行：`readRoots` **不是**给 agent 的通用文件工具用的。agent 自己不会 `readFile` 这些目录——和技能一样，受益方是 **exec 启动的子进程**。要读，靠 `cat`/脚本等命令；写则永远落回工作区。若你需要让通用 `readFile`/`listDir` 也能浏览某目录，那是另一套改动（拆读写双 root），不在本特性范围。

`full` 执行模式下工作区边界整体关闭（见 [`full-mode.md`](full-mode.md)），此时 `readRoots` 不再起约束作用——一切边界让位于沙箱（若启用）。

## 3. 配置

`readRoots` 是一个 `ScopedConfig` 字段，按 **global → scope 去重并集** 合并：会话/通道只能**追加**根目录，无法移除全局已配的根。路径**按原样使用**——请填**绝对路径**（不展开 `~` / `$ENV`）；**不存在的目录在会话构建时被静默丢弃**。

### 3.1 CLI（写 global `settings.json`）

```bash
ea config read-roots                       # 查看当前列表（缺失目录标 ⚠）
ea config read-roots add <dir...>          # 新增（相对路径按当前目录解析为绝对路径，去重）
ea config read-roots remove <dir...>       # 移除（按解析后的绝对路径匹配）
ea config read-roots clear                 # 清空
# 别名：ea config rr ...
```

等价的 `~/.enterprise-agent/settings.json`：

```json
{
  "readRoots": ["/Users/me/.enterprise-agent"]
}
```

`ea config`（生效配置概览）会显示合并后的 `readRoots`，缺失目录标注「（缺失）」。

### 3.2 Gateway（按通道，写 `gateway.json`）

Gateway 与 CLI 共用同一份 `~/.enterprise-agent/settings.json`，所以**全局 `readRoots` 对所有 gateway 会话生效**。但在多租户网关里，把配置目录全局暴露给每个用户的会话通常不合适——因此更推荐**按通道**配置：通道的 `session`（一个 `ScopedConfig`）会被原样注入它创建的每个会话，核心再与全局合并。

```json
{
  "channels": [
    {
      "name": "ops-bot",
      "session": {
        "workingDir": "/srv/workspaces",
        "readRoots": ["/etc/ops-agent"]
      }
    }
  ]
}
```

无需改 gateway 代码——`readRoots` 作为 `ScopedConfig` 字段，经 `sessionConfigFor` → `startSession({config})` → 核心 `effective()` 自动流通。该通道的会话获得 `/etc/ops-agent`（只读 + 可运行），其他通道不受影响。

> 多租户提醒：`readRoots` 里的目录对该会话的子进程**全部可读**。不要把含跨会话数据或密钥的目录（如整个 `~/.enterprise-agent/`，内含 `providers.json`、其他会话的 transcript/audit）暴露给共享或匿名通道。需要时，单独建一个只放可共享内容的窄目录再挂上去。

## 4. 实现位置

| 关注点 | 文件 |
|---|---|
| 契约字段 `ScopedConfig.readRoots` | `packages/agent-contract/src/domain.ts` |
| 合并解析 `EffectiveConfig.readRoots`（global ∪ scope，去重） | `packages/agent/src/config/store.ts`（`effective()`） |
| 注入运行时 `shared.readRoots`（过滤不存在目录）+ 沙箱 `allowRead` | `packages/agent/src/index.ts`（`buildSession` / `assemble`） |
| exec cwd 白名单 | `packages/agent/src/tools/exec.ts`（`resolveCwd`） |
| 运行时上下文字段 | `packages/agent/src/runtime/context.ts`（`SharedContext.readRoots`） |
| CLI 子命令 + 概览展示 | `apps/cli/src/commands/config.ts` |
| Gateway 通道透传（无专门代码） | `apps/gateway/src/runtime/dispatcher.ts`（`sessionConfigFor`） |

测试：`packages/agent/test/exec-read-roots.test.ts`（读根可作 cwd 运行、暴露于 `shared.readRoots`、绝不进可写 `rootPaths`）。
