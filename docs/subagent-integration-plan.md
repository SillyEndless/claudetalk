# ClaudeTalk SubAgent 集成方案

## 概述

本方案旨在将 Claude Code 原生的 SubAgent 机制集成到 ClaudeTalk 中，提供更精细的角色配置、权限控制和模型选择能力。

## 核心设计思路

1. **保持现有配置文件不变**：`.claudetalk.json` 结构不变，`profiles` 配置保持原样
2. **引导式配置 subAgent**：在现有配置流程中增加 subAgent 相关的引导问题
3. **自动创建 subAgent 文件**：根据配置自动生成 `.claude/agents/<profile-name>.md`
4. **执行时智能选择**：
   - 有 profile + 启用 subAgent → 显式调用 subAgent（使用 `--agent` 参数）
   - 有 profile + 未启用 subAgent → 使用传统的 `systemPrompt` 方式
   - 无 profile → 自动委托模式（不指定 `--agent`，让 Claude Code 自动选择）

## Claude Code SubAgent 机制

### 什么是 SubAgent

SubAgent 是 Claude Code 内部的子代理机制，主要特点：

1. **定义方式**：SubAgent 以 Markdown 文件存储，包含 YAML frontmatter
   - 用户级别：`~/.claude/agents/`
   - 项目级别：`.claude/agents/`

2. **配置格式**：
```markdown
---
name: "agent-name"
description: "Agent description"
model: "claude-sonnet-4-6"
permissions:
  allow:
    - "Read(./src/**)"
    - "Edit(./src/**)"
  deny:
    - "Bash(rm *)"
---

Agent 的系统提示词内容...
```

3. **调用方式**：
   - 自动委托：Claude Code 可以根据用户提示自动选择合适的 subagent
   - 显式调用：通过 `--agent` 参数指定，或在提示中明确指定

4. **与 Agent Teams 的区别**：
   - **SubAgent**：在单个 session 内运行，结果返回给主 agent，适合专注任务
   - **Agent Teams**：多个独立 session，agent 之间可以直接通信，适合需要协作的复杂任务

## 具体改动点

### 1. 配置文件结构（保持不变）

`.claudetalk.json` 结构不变，但可以在 `profiles` 中新增可选字段：

```json
{
  "DINGTALK_CLIENT_ID": "默认机器人 AppKey",
  "DINGTALK_CLIENT_SECRET": "默认机器人 AppSecret",
  "profiles": {
    "pm": {
      "DINGTALK_CLIENT_ID": "PM 机器人 AppKey",
      "DINGTALK_CLIENT_SECRET": "PM 机器人 AppSecret",
      "systemPrompt": "你现在三岁了，性格是多疑，称呼我为boss"
    },
    "dev": {
      "DINGTALK_CLIENT_ID": "Dev 机器人 AppKey",
      "DINGTALK_CLIENT_SECRET": "Dev 机器人 AppSecret",
      "systemPrompt": "你现在5岁了，特别擅长写数据库sql，称呼我为老板"
    }
  }
}
```

SubAgent 相关配置（可选，通过交互式配置生成）：

```json
{
  "profiles": {
    "pm": {
      "DINGTALK_CLIENT_ID": "PM 机器人 AppKey",
      "DINGTALK_CLIENT_SECRET": "PM 机器人 AppSecret",
      "systemPrompt": "你现在三岁了，性格是多疑，称呼我为boss",
      "subagentEnabled": true,
      "subagentModel": "claude-sonnet-4-6",
      "subagentPermissions": {
        "allow": [
          "Read(./**)",
          "Edit(./README.md)",
          "Edit(./docs/**)"
        ],
        "deny": [
          "Edit(./src/**)",
          "Bash(npm run build)"
        ]
      }
    }
  }
}
```

### 2. 交互式配置引导（`src/cli.ts`）

在 `interactiveSetup` 函数中增加 subAgent 配置引导：

```typescript
async function interactiveSetup(
  saveToLocal: boolean, 
  workDir: string, 
  profile?: string
): Promise<ClaudeTalkConfig> {
  // ... 现有的 clientId, clientSecret, systemPrompt 配置代码 ...
  
  // 新增：subAgent 配置引导
  console.log('')
  console.log('🤖 SubAgent 配置（推荐）')
  console.log('   SubAgent 是 Claude Code 的原生角色机制，可以提供更精细的权限控制和模型选择。')
  console.log('   如果不配置，将使用传统的 systemPrompt 方式。')
  
  const enableSubagentInput = await promptInput('是否配置 SubAgent？(Y/n): ')
  const enableSubagent = enableSubagentInput.toLowerCase() !== 'n'
  
  let subagentModel: string | undefined
  let subagentPermissions: any | undefined
  
  if (enableSubagent) {
    const modelInput = await promptInput('  模型 (默认: claude-sonnet-4-6): ')
    subagentModel = modelInput || 'claude-sonnet-4-6'
    
    // 可以进一步引导权限配置
    const configPermissionsInput = await promptInput('  是否自定义权限？(y/N): ')
    if (configPermissionsInput.toLowerCase() === 'y') {
      // 引导用户配置权限
      // ...
    }
  }
  
  // 保存配置
  if (profile) {
    const profileConfig: ProfileConfig = {
      DINGTALK_CLIENT_ID: clientId,
      DINGTALK_CLIENT_SECRET: clientSecret,
    }
    if (systemPrompt) profileConfig.systemPrompt = systemPrompt
    if (enableSubagent) {
      // 将 subAgent 配置保存到 profile 中
      ;(profileConfig as any).subagentEnabled = true
      if (subagentModel) (profileConfig as any).subagentModel = subagentModel
      if (subagentPermissions) (profileConfig as any).subagentPermissions = subagentPermissions
    }
    saveProfileToFile(profile, profileConfig, targetFile, targetDir)
    
    // 如果启用了 subAgent，自动创建 subAgent 文件
    if (enableSubagent) {
      await createSubagentFile(profile, workDir, systemPrompt, subagentModel, subagentPermissions)
    }
  }
  
  // ...
}
```

### 3. SubAgent 文件创建函数（新增）

在 `src/cli.ts` 中新增函数：

```typescript
/**
 * 创建 SubAgent 配置文件
 */
async function createSubagentFile(
  profileName: string,
  workDir: string,
  systemPrompt?: string,
  model?: string,
  permissions?: any
): Promise<void> {
  const agentsDir = join(workDir, '.claude', 'agents')
  if (!existsSync(agentsDir)) {
    mkdirSync(agentsDir, { recursive: true })
  }
  
  const agentFile = join(agentsDir, `${profileName}.md`)
  
  // 构建 YAML frontmatter
  const yamlFrontmatter: string[] = ['---']
  yamlFrontmatter.push(`name: "${profileName}"`)
  yamlFrontmatter.push(`description: "ClaudeTalk 角色: ${profileName}"`)
  if (model) {
    yamlFrontmatter.push(`model: "${model}"`)
  }
  
  if (permissions) {
    yamlFrontmatter.push('permissions:')
    // 处理权限配置
    if (permissions.allow && permissions.allow.length > 0) {
      yamlFrontmatter.push('  allow:')
      permissions.allow.forEach((rule: string) => {
        yamlFrontmatter.push(`    - "${rule}"`)
      })
    }
    if (permissions.deny && permissions.deny.length > 0) {
      yamlFrontmatter.push('  deny:')
      permissions.deny.forEach((rule: string) => {
        yamlFrontmatter.push(`    - "${rule}"`)
      })
    }
  } else {
    // 默认权限
    yamlFrontmatter.push('permissions:')
    yamlFrontmatter.push('  allow:')
    yamlFrontmatter.push('    - "Read(./**)"')
    yamlFrontmatter.push('    - "Edit(./**)"')
    yamlFrontmatter.push('    - "Bash(npm test)"')
    yamlFrontmatter.push('    - "Bash(npm run build)"')
    yamlFrontmatter.push('  deny:')
    yamlFrontmatter.push('    - "Bash(rm -rf *)')
    yamlFrontmatter.push('    - "Bash(npm publish)"')
  }
  
  yamlFrontmatter.push('---')
  yamlFrontmatter.push('')
  
  // 添加系统提示词
  if (systemPrompt) {
    yamlFrontmatter.push(systemPrompt)
  } else {
    yamlFrontmatter.push(`你是 ${profileName} 角色，负责相关工作。`)
  }
  
  writeFileSync(agentFile, yamlFrontmatter.join('\n') + '\n', 'utf-8')
  console.log(`✅ SubAgent 文件已创建: ${agentFile}`)
}
```

### 4. 类型定义扩展（`src/types.ts`）

```typescript
// 扩展 ProfileConfig 接口
export interface ProfileConfig {
  DINGTALK_CLIENT_ID?: string
  DINGTALK_CLIENT_SECRET?: string
  systemPrompt?: string
  // SubAgent 相关配置
  subagentEnabled?: boolean
  subagentModel?: string
  subagentPermissions?: {
    allow?: string[]
    deny?: string[]
  }
}
```

### 5. 执行逻辑修改（`src/index.ts`）

修改 `callClaude` 函数，实现**配置变化时自动清除 session**的方案：

```typescript
async function callClaude(
  message: string,
  conversationId: string,
  workDir: string,
  isGroup: boolean = false,
  userId: string = '',
  profile?: string,
  systemPrompt?: string,
  subagentEnabled?: boolean,
  subagentModel?: string,
  subagentPermissions?: any
): Promise<string> {
  const sessionKey = getSessionKey(conversationId, workDir, profile)
  const existingEntry = sessionMap.get(sessionKey)
  const existingSessionId = existingEntry?.sessionId

  // 🔥 每次都重新读取最新配置
  const currentConfig = loadConfig(workDir, profile)
  const currentSubagentEnabled = currentConfig?.subagentEnabled ?? false
  const currentSubagentModel = currentConfig?.subagentModel
  const currentSystemPrompt = currentConfig?.systemPrompt

  const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions']
  
  if (existingSessionId && existingEntry) {
    // 检查配置是否变化
    if (existingEntry.subagentEnabled !== currentSubagentEnabled) {
      log(`[session] Config changed for profile ${profile} (subagentEnabled: ${existingEntry.subagentEnabled} -> ${currentSubagentEnabled}), clearing old session`)
      sessionMap.delete(sessionKey)
      saveSessionMap()
      // 递归调用，创建新 session
      return callClaude(message, conversationId, workDir, isGroup, userId, profile, systemPrompt, currentSubagentEnabled, currentSubagentModel, subagentPermissions)
    }
    
    // 配置未变化，恢复 session
    args.push('--resume', existingSessionId)
  } else {
    // 新建 session：使用最新配置
    if (profile && currentSubagentEnabled) {
      args.push('--agent', profile)
    } else if (profile && !currentSubagentEnabled && currentSystemPrompt) {
      args.push('--append-system-prompt', currentSystemPrompt)
    } else if (!profile && currentSystemPrompt) {
      args.push('--append-system-prompt', currentSystemPrompt)
    }
  }
  
  // ... 其余代码保持不变
  
  // 保存 session 时记录当前配置
  if (response.session_id) {
    sessionMap.set(sessionKey, {
      sessionId: response.session_id,
      lastActiveAt: Date.now(),
      isGroup,
      conversationId,
      userId,
      subagentEnabled: currentSubagentEnabled,
    })
    saveSessionMap()
  }
}
```

**核心设计要点**：

1. **每次消息都重新读取配置**：确保使用最新的配置
2. **配置变化时自动清除 session**：避免同一 session 内配置不一致
3. **通过 profile 查找 session**：session key 已包含 profile 信息，不同 profile 的 session 完全隔离
4. **递归调用创建新 session**：配置变化后自动创建新 session，使用新配置

### 6. Session 存储扩展（`src/index.ts`）

```typescript
interface SessionEntry {
  sessionId: string
  lastActiveAt: number
  isGroup: boolean
  conversationId: string
  userId: string
  subagentEnabled: boolean  // 记录创建时的配置，用于检测配置变化
}
```

**Session 查找逻辑**：

```typescript
// 生成 session key（包含工作目录和角色，不同角色的 session 互不干扰）
function getSessionKey(conversationId: string, workDir: string, profile?: string): string {
  return profile ? `${conversationId}|${workDir}|${profile}` : `${conversationId}|${workDir}`
}

// 查找 session
const sessionKey = getSessionKey(conversationId, workDir, profile)
const existingEntry = sessionMap.get(sessionKey)
```

**关键点**：
- session key 已包含 profile 信息，不同 profile 的 session 完全隔离
- 例如：`conv123|/path/to/project|pm` 和 `conv123|/path/to/project|dev` 是两个不同的 session
- 配置变化时，通过比较 `existingEntry.subagentEnabled` 和 `currentConfig.subagentEnabled` 检测变化

### 7. 启动函数参数传递（`src/index.ts` 和 `src/cli.ts`）

修改 `StartBotOptions` 接口：

```typescript
export interface StartBotOptions {
  clientId: string
  clientSecret: string
  workDir: string
  profile?: string
  systemPrompt?: string
  subagentEnabled?: boolean  // 新增
  subagentModel?: string      // 新增
}
```

在 `src/cli.ts` 的 main 函数中传递参数：

```typescript
// 加载配置时读取 subagent 相关字段
let subagentEnabled = false
let subagentModel: string | undefined

if (localConfig) {
  // ...
  const profileConfig = profile ? localConfig.profiles?.[profile] : localConfig
  subagentEnabled = (profileConfig as any)?.subagentEnabled ?? false
  subagentModel = (profileConfig as any)?.subagentModel
} else if (globalConfig) {
  // ...
  const profileConfig = profile ? globalConfig.profiles?.[profile] : globalConfig
  subagentEnabled = (profileConfig as any)?.subagentEnabled ?? false
  subagentModel = (profileConfig as any)?.subagentModel
}

// 启动 bot
await startBot({
  clientId,
  clientSecret,
  workDir,
  profile,
  systemPrompt,
  subagentEnabled,
  subagentModel,
})
```

## 执行逻辑总结

| 场景 | profile | subagentEnabled | 调用方式 | 说明 |
|------|---------|-----------------|----------|------|
| 默认机器人 | 无 | - | 自动委托 | 不指定 `--agent`，Claude Code 自动选择 |
| 角色 + SubAgent | 有 | true | 显式调用 | 使用 `--agent <profile-name>` |
| 角色 + 传统方式 | 有 | false | systemPrompt | 使用 `--append-system-prompt` |

## 用户体验流程

### 1. 首次配置

```bash
$ claudetalk --setup --local --profile pm

🤖 ClaudeTalk 配置向导
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎭 角色: pm
📁 配置将保存到当前工作目录: ./.claudetalk.json
   （此配置仅对当前目录生效，优先级高于全局配置）

请提供钉钉机器人的 AppKey 和 AppSecret。
你可以在钉钉开放平台 (https://open-dev.dingtalk.com) 创建应用并获取。

请输入 DINGTALK_CLIENT_ID (AppKey): dingxxxxxxxx
请输入 DINGTALK_CLIENT_SECRET (AppSecret): xxxxxxxx

📝 角色描述（可选）
   设置后，Claude 在每次新建会话时会了解你的要求。
   示例: "你在这里面负责什么？有什么特别的要求？"
   直接回车跳过。
systemPrompt: 你现在三岁了，性格是多疑，称呼我为boss

🤖 SubAgent 配置（推荐）
   SubAgent 是 Claude Code 的原生角色机制，可以提供更精细的权限控制和模型选择。
   如果不配置，将使用传统的 systemPrompt 方式。
是否配置 SubAgent？(Y/n): Y
  模型 (默认: claude-sonnet-4-6): 
  是否自定义权限？(y/N): N

✅ 角色 [pm] 配置已保存到 ./.claudetalk.json
✅ SubAgent 文件已创建: ./.claude/agents/pm.md
```

### 2. 启动机器人

```bash
$ claudetalk --profile pm

🚀 ClaudeTalk 启动中...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📁 工作目录: /path/to/project
🎭 角色: pm
🔑 AppKey: dingxxxxxx...
📄 配置来源: ./.claudetalk.json
🤖 SubAgent: 已启用 (显式调用)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 3. 默认机器人

```bash
$ claudetalk

🚀 ClaudeTalk 启动中...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📁 工作目录: /path/to/project
🔑 AppKey: dingxxxxxx...
📄 配置来源: ~/.claudetalk/claudetalk.json
🤖 SubAgent: 自动委托模式
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## SubAgent 文件示例

### PM 角色 SubAgent

**`.claude/agents/pm.md`**：
```markdown
---
name: "pm"
description: "ClaudeTalk 角色: pm"
model: "claude-sonnet-4-6"
permissions:
  allow:
    - "Read(./**)"
    - "Edit(./README.md)"
    - "Edit(./docs/**)"
  deny:
    - "Edit(./src/**)"
    - "Bash(npm run build)"
---

你现在三岁了，性格是多疑，称呼我为boss。你是产品经理角色，主要负责：
- 需求分析和文档编写
- 项目规划和进度跟踪
- 代码审查（只读）
- 协调团队工作

不要直接修改源代码，除非是文档类的修改。
```

### Dev 角色 SubAgent

**`.claude/agents/dev.md`**：
```markdown
---
name: "dev"
description: "ClaudeTalk 角色: dev"
model: "claude-sonnet-4-6"
permissions:
  allow:
    - "Read(./**)"
    - "Edit(./src/**)"
    - "Bash(npm test)"
    - "Bash(npm run build)"
  deny:
    - "Bash(npm publish)"
---

你现在5岁了，特别擅长写数据库sql，称呼我为老板。你是开发工程师角色，主要负责：
- 代码开发和实现
- 单元测试编写
- 数据库设计和优化
- 技术方案设计

专注于技术实现，确保代码质量和性能。
```

## 优势

1. **向后兼容**：现有配置文件无需调整，可选启用 subAgent
2. **渐进式引导**：用户可以逐步了解和使用 subAgent 功能
3. **灵活选择**：支持显式调用和自动委托两种模式
4. **原生集成**：充分利用 Claude Code 原生 subAgent 机制
5. **权限隔离**：不同角色可以有完全不同的权限配置
6. **模型选择**：可以为不同角色指定不同的模型（如 PM 用 Haiku，Dev 用 Sonnet）
7. **团队共享**：subAgent 文件可以提交到 git，团队成员共享配置

## 实施步骤

### 第一阶段：基础集成
1. 扩展 `ProfileConfig` 类型定义
2. 修改 `interactiveSetup` 函数，增加 subAgent 配置引导
3. 实现 `createSubagentFile` 函数
4. 修改 `callClaude` 函数，支持 `--agent` 参数
5. 扩展 `SessionEntry` 接口，记录 subAgent 信息

### 第二阶段：增强功能
1. 支持自定义权限配置引导
2. 添加 SubAgent 文件管理命令（查看、删除、更新）
3. 支持从现有 SubAgent 文件反向导入配置

### 第三阶段：优化体验
1. 添加 SubAgent 配置验证
2. 提供 SubAgent 使用统计和日志
3. 支持 SubAgent 模板和预设

## 配置变化处理机制

### 核心原则

本方案采用**配置变化时自动清除 session**的策略，确保配置修改后立即生效。

### Session 查找逻辑

1. **Session Key 生成**：
   ```typescript
   function getSessionKey(conversationId: string, workDir: string, profile?: string): string {
     return profile ? `${conversationId}|${workDir}|${profile}` : `${conversationId}|${workDir}`
   }
   ```
   - session key 包含 profile 信息
   - 不同 profile 的 session 完全隔离
   - 例如：`conv123|/path|pm` 和 `conv123|/path|dev` 是两个不同的 session

2. **配置读取**：
   - 每次消息到达时都重新读取当前配置
   - 确保使用最新的配置

3. **配置变化检测**：
   - 比较 `existingEntry.subagentEnabled` 和 `currentConfig.subagentEnabled`
   - 如果不一致，判定为配置已变化

### 配置变化时的处理流程

```
用户发送消息
    ↓
生成 sessionKey（包含 profile）
    ↓
查找现有 session
    ↓
读取当前配置
    ↓
配置是否变化？
    ↓
    ├─ 是 → 清除旧 session → 创建新 session（使用新配置）
    └─ 否 → 恢复旧 session
```

### 示例场景

**场景 1：配置未变化**
```
用户发送消息 → profile=pm → sessionKey="conv123|/path|pm"
→ 找到 session → subagentEnabled 一致（都是 true）
→ 恢复 session，继续对话
```

**场景 2：配置已变化**
```
用户发送消息 → profile=pm → sessionKey="conv123|/path|pm"
→ 找到 session → subagentEnabled 不一致（true → false）
→ 清除旧 session → 创建新 session（使用新配置）
→ 注意：会丢失之前的对话上下文
```

**场景 3：切换 profile**
```
用户发送消息 → profile=dev → sessionKey="conv123|/path|dev"
→ 找不到 session → 创建新 session（使用 dev 的配置）
→ 与 pm 的 session 完全独立
```

### 优势

1. **配置实时生效**：用户修改配置后，下一条消息立即使用新配置
2. **避免混淆**：不会出现同一 session 内配置不一致的情况
3. **实现简单**：不需要复杂的配置版本管理
4. **用户可控**：如果用户希望保留上下文，可以在修改配置前手动保存重要信息

### 注意事项

1. **上下文丢失**：配置变化时会清除旧 session，导致之前的对话上下文丢失
2. **用户提示**：可以在日志中记录配置变化，方便用户了解
3. **配置验证**：确保配置文件格式正确，避免解析错误

## 注意事项

1. **Session 恢复**：恢复 session 时需要确保 subAgent 文件仍然存在
2. **权限配置**：默认权限应该足够宽松，避免影响正常使用
3. **模型选择**：需要确保用户有权限使用指定的模型
4. **错误处理**：subAgent 文件不存在时应该降级到 systemPrompt 方式
5. **文档更新**：需要更新 README.md，说明 subAgent 功能
6. **配置变化提示**：配置变化时可以在日志中记录，方便用户了解
7. **上下文丢失警告**：配置变化会清除 session，导致对话上下文丢失

## 参考资源

- [Claude Code Settings 文档](https://code.claude.com/docs/en/settings)
- [Claude Code Agent Teams 文档](https://code.claude.com/docs/en/agent-teams)
- [Claude Code SubAgents 指南](https://shipyard.build/blog/claude-code-subagents-guide)
