/**
 * ClaudeTalk 启动入口
 * 根据 profile 配置的 channel 类型，创建对应的 Channel 实例并启动
 */

import { getChannelDescriptor } from './channels/index.js'
import { callClaude, clearSession, createLogger, findLastActivePrivateSession, getSessionId, getSessionSettings, listAllSessions, loadConfig, log, scanClaudeCodeSessions, setSessionId, updateSessionSettings } from './core/claude.js'
import type { StreamEvent } from './core/claude.js'
import { closeLogFile, initLogFile } from './core/logger.js'
import type { Channel, ChannelMessageContext, ClaudeTalkConfig } from './types.js'

export interface StartBotOptions {
  workDir: string
  profile?: string
}

// ========== 工具函数 ==========

/** 将 UUID 截断为前 8 位短 ID */
function shortId(id: string): string {
  return id.substring(0, 8)
}

/** 将时间戳转为相对时间描述 */
function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  return `${Math.floor(days / 30)}个月前`
}

// ========== 内置指令列表 ==========
const RESET_COMMANDS = new Set(['新会话', '清空记忆', '/new', '/reset', '/clear'])
const COMPACT_COMMANDS = new Set(['/compact', '压缩上下文'])
const HELP_COMMANDS = new Set(['/help', '帮助'])

const VALID_EFFORT_LEVELS = ['low', 'medium', 'high', 'max']
const VALID_MODELS = [
  { alias: 'sonnet', desc: 'Claude Sonnet 4.6（默认，平衡性能与成本）' },
  { alias: 'opus', desc: 'Claude Opus 4.6（最强推理能力）' },
  { alias: 'haiku', desc: 'Claude Haiku 4.5（最快，低成本）' },
]

const HELP_TEXT = [
  '🤖 **ClaudeTalk 指令帮助**',
  '',
  '**会话管理**',
  '- **新会话** / **/new** / **/clear** — 清空当前会话记忆，开启全新对话',
  '- **/compact** / **压缩上下文** — 压缩对话上下文（减少 token 用量）',
  '- **会话列表** / **/sessions** — 查看所有会话及其 ID',
  '- **恢复会话 <ID>** / **/resume <ID>** — 切换到指定会话（支持 8 位短 ID）',
  '',
  '**Claude Code 设置**',
  '- **/model** — 查看当前模型 / 切换模型',
  '  可用模型: ' + VALID_MODELS.map(m => `${m.alias} (${m.desc})`).join(' | '),
  '  用法: `/model sonnet`',
  '- **/effort** — 查看当前推理深度 / 设置推理深度',
  '  可用级别: ' + VALID_EFFORT_LEVELS.join(', '),
  '  用法: `/effort high`',
  '- **/plan** — 切换 Plan 模式（开启后 Claude 先制定计划再执行）',
  '- **/init** — 初始化 CLAUDE.md（让 Claude 分析项目并生成配置）',
  '',
  '**其他**',
  '- **帮助** / **/help** — 显示本帮助信息',
  '',
  '发送其他任意消息将由 Claude Code 处理。',
].join('\n')

/**
 * 根据配置创建对应的 Channel 实例
 * 通过注册表查找对应的 ChannelDescriptor，调用其 create 工厂方法
 */
function createChannel(channelType: string, config: ClaudeTalkConfig, workDir: string, profileName?: string): Channel {
  const descriptor = getChannelDescriptor(channelType)
  if (!descriptor) {
    throw new Error(`不支持的 channel 类型: ${channelType}，请检查配置文件中的 channel 字段`)
  }

  // 取出该 Channel 的嵌套配置（如 config.dingtalk、config.discord）
  const channelConfig = (config[channelType] ?? {}) as Record<string, string>

  // 校验必填字段
  for (const field of descriptor.configFields) {
    if (field.required && !channelConfig[field.key]) {
      throw new Error(
        `${channelType} 配置缺失字段 "${field.key}"，请在 profile.${channelType}.${field.key} 中填写`
      )
    }
  }

  // 将 profile 级别的通用字段注入到 channelConfig，供 Channel 实现使用
  const enrichedChannelConfig: Record<string, string> = {
    ...channelConfig,
    ...(profileName ? { profileName } : {}),
    ...(config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
    workDir, // 注入工作目录，用于存储项目级别的配置文件（如 chat-members.json）
  }

  return descriptor.create(enrichedChannelConfig)
}

/**
 * 启动 Bot
 */
export async function startBot(options: StartBotOptions): Promise<void> {
  const { workDir, profile } = options

  // 初始化日志文件
  initLogFile(workDir)

  const config = loadConfig(workDir, profile)
  if (!config) {
    throw new Error(`找不到配置，请先运行 claudetalk --setup${profile ? ` --profile ${profile}` : ''}`)
  }

  const channelType = config.channel ?? 'dingtalk'
  const channel = createChannel(channelType, config, workDir, profile)
  const logger = createLogger(channelType, profile)

  logger(`[startBot] Starting channel=${channelType}, workDir=${workDir}`)

  // 注册进程退出时的日志文件关闭
  process.on('SIGINT', () => {
    logger('[startBot] Received SIGINT, shutting down...')
    closeLogFile()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    logger('[startBot] Received SIGTERM, shutting down...')
    closeLogFile()
    process.exit(0)
  })

  process.on('exit', () => {
    closeLogFile()
  })

  // 注册统一消息处理器
  channel.onMessage(async (context: ChannelMessageContext, message: string) => {
    // 去掉飞书群聊中的 @机器人 前缀（如 "@_user_1 /new" → "/new"）
    const strippedMessage = message.replace(/^@\S+\s*/, '').trim()
    const command = strippedMessage.toLowerCase()

    // 内置指令：清空会话（使用原始消息判断，不受 processedMessage 影响）
    if (RESET_COMMANDS.has(command)) {
      const hadSession = clearSession(context.conversationId, workDir, profile, channelType)
      const replyText = hadSession
        ? '🔄 已清空当前会话记忆，下次发消息将开启全新对话。'
        : '💡 当前没有活跃的会话记忆，发消息即可开始新对话。'
      await channel.sendMessage(context.conversationId, replyText, context.isGroup)
      return
    }

    // Claude Code 命令：压缩上下文
    if (COMPACT_COMMANDS.has(command)) {
      const hadSession = clearSession(context.conversationId, workDir, profile, channelType)
      const replyText = hadSession
        ? '🔄 已压缩当前会话上下文，下次发消息将开启新会话。\n（旧会话可通过 /resume 恢复）'
        : '💡 当前没有活跃的会话，发消息即可开始新对话。'
      await channel.sendMessage(context.conversationId, replyText, context.isGroup)
      return
    }

    // Claude Code 命令：切换模型
    if (command === '/model') {
      const settings = getSessionSettings(context.conversationId, workDir, profile, channelType)
      const currentModel = settings?.model || '默认（未指定）'
      const modelList = VALID_MODELS.map(m => `- **${m.alias}**: ${m.desc}`).join('\n')
      const replyText = `📊 当前模型: ${currentModel}\n\n可用模型:\n${modelList}\n\n用法: /model sonnet`
      await channel.sendMessage(context.conversationId, replyText, context.isGroup)
      return
    }
    if (command.startsWith('/model ')) {
      const modelName = strippedMessage.replace(/^\/model\s+/, '').trim().toLowerCase()
      const matched = VALID_MODELS.find(m => m.alias === modelName)
      if (!matched) {
        const modelList = VALID_MODELS.map(m => `${m.alias}`).join(', ')
        await channel.sendMessage(context.conversationId, `❌ 不支持的模型: ${modelName}\n可用模型: ${modelList}`, context.isGroup)
        return
      }
      updateSessionSettings(context.conversationId, workDir, { model: matched.alias }, profile, channelType)
      await channel.sendMessage(context.conversationId, `✅ 已切换模型为: ${matched.alias}（${matched.desc}）`, context.isGroup)
      return
    }

    // Claude Code 命令：设置推理深度
    if (command === '/effort') {
      const settings = getSessionSettings(context.conversationId, workDir, profile, channelType)
      const currentEffort = settings?.effort || '默认（未指定）'
      const replyText = `📊 当前推理深度: ${currentEffort}\n\n可用级别: ${VALID_EFFORT_LEVELS.join(', ')}\n\n用法: /effort high`
      await channel.sendMessage(context.conversationId, replyText, context.isGroup)
      return
    }
    if (command.startsWith('/effort ')) {
      const level = strippedMessage.replace(/^\/effort\s+/, '').trim().toLowerCase()
      if (!VALID_EFFORT_LEVELS.includes(level)) {
        await channel.sendMessage(context.conversationId, `❌ 无效的推理深度: ${level}\n可用级别: ${VALID_EFFORT_LEVELS.join(', ')}`, context.isGroup)
        return
      }
      updateSessionSettings(context.conversationId, workDir, { effort: level }, profile, channelType)
      await channel.sendMessage(context.conversationId, `✅ 已设置推理深度为: ${level}`, context.isGroup)
      return
    }

    // Claude Code 命令：切换 Plan 模式
    if (command === '/plan') {
      const settings = getSessionSettings(context.conversationId, workDir, profile, channelType)
      const newPlanMode = !(settings?.planMode)
      updateSessionSettings(context.conversationId, workDir, { planMode: newPlanMode }, profile, channelType)
      const replyText = newPlanMode
        ? '✅ 已开启 Plan 模式。Claude 将先制定计划再执行，适合复杂任务。'
        : '✅ 已关闭 Plan 模式，恢复默认执行模式。'
      await channel.sendMessage(context.conversationId, replyText, context.isGroup)
      return
    }

    // Claude Code 命令：初始化 CLAUDE.md
    if (command === '/init') {
      const fs = await import('fs')
      const path = await import('path')
      const claudeMdPath = path.join(workDir, 'CLAUDE.md')
      if (fs.existsSync(claudeMdPath)) {
        const content = fs.readFileSync(claudeMdPath, 'utf-8')
        await channel.sendMessage(context.conversationId, `💡 CLAUDE.md 已存在（${content.length} 字符），无需重新初始化。`, context.isGroup)
        return
      }
      fs.writeFileSync(claudeMdPath, '', 'utf-8')
      await channel.sendMessage(context.conversationId, '✅ 已创建空的 CLAUDE.md 文件。\n请发送消息让 Claude 为项目生成合适的内容，例如:\n"请分析当前项目结构，为 CLAUDE.md 填写项目描述、技术栈和开发规范。"', context.isGroup)
      return
    }

    // 内置指令：帮助（使用原始消息判断，不受 contextMessage 影响）
    if (HELP_COMMANDS.has(command)) {
      await channel.sendMessage(context.conversationId, HELP_TEXT, context.isGroup)
      return
    }

    // 内置指令：列出所有会话（扫描 Claude Code 会话目录）
    if (command === '/sessions' || command === '会话列表') {
      const ccSessions = scanClaudeCodeSessions(workDir)
      if (ccSessions.length === 0) {
        await channel.sendMessage(context.conversationId, '📋 当前项目没有任何会话记录。', context.isGroup)
        return
      }

      // 获取当前会话 ID
      const currentSessionId = getSessionId(context.conversationId, workDir, profile, channelType)

      const lines = ['📋 项目会话列表：', '']
      for (let i = 0; i < ccSessions.length; i++) {
        const s = ccSessions[i]
        const isCurrent = s.sessionId === currentSessionId
        const marker = isCurrent ? ' ◀ 当前' : ''
        lines.push(`${i + 1}.${marker} ${formatRelativeTime(s.lastModified)}`)
        lines.push(`   ${shortId(s.sessionId)}`)
        if (s.firstMessage) {
          lines.push(`   "${s.firstMessage}"`)
        }
        if (i < ccSessions.length - 1) lines.push('')
      }
      lines.push('')
      lines.push('使用 /resume <会话ID> 切换到指定会话（支持 8 位短 ID）')
      await channel.sendMessage(context.conversationId, lines.join('\n'), context.isGroup)
      return
    }

    // 内置指令：恢复/切换会话
    if (command.startsWith('/resume ') || command.startsWith('恢复会话 ')) {
      const inputId = strippedMessage.replace(/^(\/resume|恢复会话)\s+/, '').trim()
      if (!inputId) {
        await channel.sendMessage(context.conversationId, '用法：/resume <会话ID>', context.isGroup)
        return
      }

      // 支持短 ID（8 位）和完整 UUID
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      const shortIdRegex = /^[0-9a-f]{8}$/i

      let resolvedSessionId: string | null = null

      if (uuidRegex.test(inputId)) {
        resolvedSessionId = inputId
      } else if (shortIdRegex.test(inputId)) {
        // 短 ID：在所有会话中查找前 8 位匹配的
        const ccSessions = scanClaudeCodeSessions(workDir)
        const matches = ccSessions.filter(s => s.sessionId.startsWith(inputId.toLowerCase()))
        if (matches.length === 1) {
          resolvedSessionId = matches[0].sessionId
        } else if (matches.length > 1) {
          await channel.sendMessage(
            context.conversationId,
            `❌ 找到 ${matches.length} 个匹配的会话，请使用更长的 ID。\n${matches.map(m => `  ${shortId(m.sessionId)}: "${m.firstMessage || '(无记录)'}"`).join('\n')}`,
            context.isGroup
          )
          return
        }
      }

      if (!resolvedSessionId) {
        await channel.sendMessage(context.conversationId, '❌ 会话ID无效或未找到，请检查是否正确。', context.isGroup)
        return
      }

      setSessionId(resolvedSessionId, context.conversationId, workDir, context.isGroup, context.userId, profile, channelType)
      await channel.sendMessage(
        context.conversationId,
        `🔄 已切换到会话：${shortId(resolvedSessionId)}\n下次发送消息将恢复该会话。`,
        context.isGroup
      )
      return
    }

    // 调用 Claude Code CLI 处理消息
    // 流式输出：使用卡片消息实时展示 Claude 的输出内容
    const startTime = Date.now()
    let streamingMessageId: string | null = null
    let streamingTimer: ReturnType<typeof setTimeout> | null = null
    let streamingUpdateTimer: ReturnType<typeof setInterval> | null = null
    let accumulatedStreamText = ''
    let currentToolName: string | null = null
    let hasStreamingStarted = false
    const STREAMING_DELAY_MS = 3000  // 3秒后才发送流式卡片（避免快速响应时闪烁）
    const STREAMING_UPDATE_INTERVAL_MS = 1500  // 每1.5秒更新一次流式卡片

    // 活动状态追踪：区分"进程已启动"和"正在处理"
    let claudeHasSpawned = false
    let claudeHasOutput = false
    let lastActivityTime = 0
    let lastActivityDetail: string | undefined

    // 延迟发送流式卡片
    streamingTimer = setTimeout(async () => {
      if (!channel.sendStreamingMessage) return
      if (!claudeHasSpawned) return
      try {
        streamingMessageId = await channel.sendStreamingMessage(context.conversationId, context.isGroup)
        if (streamingMessageId) {
          // 立即更新一次当前已有内容
          if (accumulatedStreamText || currentToolName) {
            const displayContent = buildStreamDisplayContent(accumulatedStreamText, currentToolName)
            await channel.updateStreamingMessage!(context.conversationId, streamingMessageId, displayContent, context.isGroup)
          }
          // 定期更新流式卡片
          streamingUpdateTimer = setInterval(async () => {
            if (streamingMessageId && (accumulatedStreamText || currentToolName)) {
              const displayContent = buildStreamDisplayContent(accumulatedStreamText, currentToolName)
              channel.updateStreamingMessage!(context.conversationId, streamingMessageId, displayContent, context.isGroup).catch(() => {})
            }
          }, STREAMING_UPDATE_INTERVAL_MS)
        }
      } catch (e) {
        logger(`[streaming] Failed to send streaming message: ${e}`)
      }
    }, STREAMING_DELAY_MS)

    function buildStreamDisplayContent(text: string, toolName: string | null): string {
      let content = ''
      if (toolName) {
        content += `**🔧 ${toolName}**\n\n`
      }
      if (text) {
        content += text
      }
      if (!content) {
        content = '**Claude 正在思考...**'
      }
      return content
    }

    try {
      const { replyText, sessionId } = await callClaude({
        message,
        conversationId: context.conversationId,
        workDir,
        isGroup: context.isGroup,
        userId: context.userId,
        profile,
        channel: channelType,
        processedMessage: context.processedMessage,
        onActivity: (type, detail) => {
          if (type === 'spawned') {
            claudeHasSpawned = true
            logger(`[progress] Claude process spawned`)
          } else {
            claudeHasOutput = true
            lastActivityTime = Date.now()
            if (detail) lastActivityDetail = detail
          }
        },
        onStreamEvent: (event: StreamEvent) => {
          if (event.type === 'text' && event.text) {
            accumulatedStreamText += event.text
            hasStreamingStarted = true
          } else if (event.type === 'tool_use') {
            currentToolName = event.toolName || null
            if (accumulatedStreamText) {
              accumulatedStreamText += '\n\n'
            }
          } else if (event.type === 'tool_result') {
            currentToolName = null
          } else if (event.type === 'result') {
            currentToolName = null
            if (event.result) {
              accumulatedStreamText = event.result
            }
          }
        },
      })

      // 停止流式更新定时器
      if (streamingTimer) { clearTimeout(streamingTimer); streamingTimer = null }
      if (streamingUpdateTimer) { clearInterval(streamingUpdateTimer); streamingUpdateTimer = null }

      logger(`[onMessage] Claude reply (first 200 chars): "${replyText.substring(0, 200)}"`)

      // 附带 session ID（直接使用 callClaude 返回值，确保每次都有）
      const finalReply = sessionId
        ? `${replyText}\n\n---\n🔄 会话: ${shortId(sessionId)}`
        : replyText

      // 使用流式消息完成：发送最终文本 + 删除卡片
      if (streamingMessageId && channel.finishStreamingMessage) {
        await channel.finishStreamingMessage(context.conversationId, streamingMessageId, finalReply, context.isGroup)
      } else {
        // 回退：普通发送
        await channel.sendMessage(context.conversationId, finalReply, context.isGroup)
      }
    } catch (error) {
      // 停止流式更新定时器
      if (streamingTimer) { clearTimeout(streamingTimer); streamingTimer = null }
      if (streamingUpdateTimer) { clearInterval(streamingUpdateTimer); streamingUpdateTimer = null }

      // 删除流式卡片
      if (streamingMessageId && channel.clearThinkingIndicator) {
        await channel.clearThinkingIndicator(context.conversationId, streamingMessageId).catch(() => {})
      }

      logger(`[ERROR] ${error}`)
      const errorText = `处理消息时出错: ${error instanceof Error ? error.message : String(error)}`
      await channel.sendMessage(context.conversationId, errorText, context.isGroup).catch(() => {})
    }
  })

  await channel.start()
  logger(`[startBot] ${channelType} Bot 已启动`)

  // 连接成功后发上线通知
  if (channel.sendOnlineNotification) {
    const lastSession = findLastActivePrivateSession(workDir, channelType, profile)
    if (lastSession?.userId) {
      await channel.sendOnlineNotification(lastSession.userId, workDir).catch((error) => {
        logger(`[notify] 上线通知发送失败: ${error}`)
      })
    }
  }
}