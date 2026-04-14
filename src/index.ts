/**
 * ClaudeTalk 启动入口
 * 根据 profile 配置的 channel 类型，创建对应的 Channel 实例并启动
 */

import { getChannelDescriptor } from './channels/index.js'
import { callClaude, clearSession, createLogger, findLastActivePrivateSession, getSessionId, listAllSessions, loadConfig, log, scanClaudeCodeSessions, setSessionId } from './core/claude.js'
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
const RESET_COMMANDS = new Set(['新会话', '清空记忆', '/new', '/reset'])
const HELP_COMMANDS = new Set(['/help', '帮助'])

const HELP_TEXT = [
  '🤖 **ClaudeTalk 指令帮助**',
  '',
  '- **新会话** 或 **/new** — 清空当前会话记忆，开启全新对话',
  '- **清空记忆** 或 **/reset** — 同上',
  '- **会话列表** 或 **/sessions** — 查看所有会话及其 ID',
  '- **恢复会话 <ID>** 或 **/resume <ID>** — 切换到指定会话（支持 8 位短 ID）',
  '- **帮助** 或 **/help** — 显示本帮助信息',
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
      })
      logger(`[onMessage] Claude reply (first 200 chars): "${replyText.substring(0, 200)}"`)
      // 附带 session ID（直接使用 callClaude 返回值，确保每次都有）
      const finalReply = sessionId
        ? `${replyText}\n\n---\n🔄 会话: ${shortId(sessionId)}`
        : replyText
      await channel.sendMessage(context.conversationId, finalReply, context.isGroup)
    } catch (error) {
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