#!/bin/bash
set -e

# ============================
# ClaudeTalk 一键部署脚本
# 仓库安装到脚本所在目录的 claudetalk/
# 数据文件通过 CLAUDETALK_HOME 存放在仓库目录内
# 工作目录 (Claude Code cwd) 为脚本所在目录
# ============================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$SCRIPT_DIR/claudetalk"
SERVICE_NAME="claudetalk"
REPO_URL="git@github.com:SillyEndless/claudetalk.git"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
step()  { echo -e "\n${BLUE}===> ${1} ====${NC}"; }

# ============================
# 帮助信息
# ============================
usage() {
    echo "用法: $0 [命令]"
    echo ""
    echo "命令:"
    echo "  install   安装/更新 ClaudeTalk (默认)"
    echo "  uninstall 卸载 ClaudeTalk 并清理所有文件"
    echo "  status    查看服务状态"
    echo "  logs      查看实时日志"
    echo "  help      显示此帮助信息"
    exit 0
}

[ "$1" = "help" ] && usage

# ============================
# 卸载
# ============================
if [ "$1" = "uninstall" ]; then
    echo ""
    warn "即将卸载 ClaudeTalk 并删除所有相关文件"
    read -p "确认卸载？[y/N]: " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        echo "已取消"
        exit 0
    fi

    echo ""

    # 停止并移除 systemd 服务
    if systemctl is-enabled "$SERVICE_NAME" &>/dev/null; then
        step "停止并移除 systemd 服务"
        sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true
        sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true
        sudo rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
        sudo systemctl daemon-reload
        info "systemd 服务已移除"
    fi

    # 移除全局 npm link
    if command -v claudetalk &>/dev/null; then
        step "移除全局链接"
        npm unlink -g claudetalk 2>/dev/null || true
        info "全局链接已移除"
    fi

    # 删除安装目录 (仓库 + 所有数据)
    if [ -d "$INSTALL_DIR" ]; then
        step "删除安装目录: $INSTALL_DIR"
        rm -rf "$INSTALL_DIR"
        info "安装目录已删除"
    fi

    # 清理旧版残留文件 (在脚本目录下的散落文件)
    for old_file in "$SCRIPT_DIR/.claudetalk.json" "$SCRIPT_DIR/.claudetalk-sessions.json" "$SCRIPT_DIR/claudetalk.service"; do
        if [ -f "$old_file" ]; then
            rm -f "$old_file"
            info "已删除: $old_file"
        fi
    done
    if [ -d "$SCRIPT_DIR/.claudetalk" ]; then
        rm -rf "$SCRIPT_DIR/.claudetalk"
        info "已删除: $SCRIPT_DIR/.claudetalk/"
    fi

    echo ""
    echo "========================================"
    info "ClaudeTalk 已完全卸载"
    echo "========================================"
    exit 0
fi

# ============================
# 查看状态
# ============================
if [ "$1" = "status" ]; then
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        info "服务运行中"
        systemctl status "$SERVICE_NAME" --no-pager -l
    else
        warn "服务未运行"
    fi
    echo ""
    info "安装目录: $INSTALL_DIR"
    info "工作目录: $SCRIPT_DIR"
    [ -d "$INSTALL_DIR" ] && ls -la "$INSTALL_DIR/" | grep -E '^\-|^d' || echo "  (目录不存在)"
    exit 0
fi

# ============================
# 查看日志
# ============================
if [ "$1" = "logs" ]; then
    journalctl -u "$SERVICE_NAME" -f --no-pager
    exit 0
fi

# ============================
# 以下是 install 流程
# ============================

step "0. 检查前置依赖"

# Node.js
if ! command -v node &>/dev/null; then
    error "未找到 Node.js，请先安装 (https://nodejs.org)"
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
    error "Node.js 版本过低 (当前 $(node -v))，需要 >= v18"
fi
info "Node.js $(node -v) ✓"

# npm
if ! command -v npm &>/dev/null; then
    error "未找到 npm"
fi
info "npm $(npm -v) ✓"

# Claude Code CLI
if ! command -v claude &>/dev/null; then
    error "未找到 claude 命令，请先安装 Claude Code CLI 并登录"
fi
info "Claude Code $(claude --version 2>/dev/null | head -1) ✓"

# python3 (可选)
if command -v python3 &>/dev/null; then
    info "Python $(python3 --version 2>&1 | awk '{print $2}') ✓"
fi

echo ""
echo "========================================"
info "安装目录: $INSTALL_DIR"
info "工作目录: $SCRIPT_DIR"
info "数据文件通过 CLAUDETALK_HOME 存放在安装目录内"
echo "========================================"

# ============================
# 1. 克隆/更新项目
# ============================
step "1. 克隆/更新项目"

if [ -d "$INSTALL_DIR/.git" ]; then
    info "项目已存在，执行 git pull 更新..."
    git -C "$INSTALL_DIR" pull
    NEED_BUILD=1
else
    if [ -d "$INSTALL_DIR" ]; then
        warn "$INSTALL_DIR 已存在但不是 git 仓库"
        read -p "是否删除并重新克隆？[y/N]: " REMOVE
        if [[ "$REMOVE" =~ ^[Yy]$ ]]; then
            rm -rf "$INSTALL_DIR"
        else
            error "请手动处理 $INSTALL_DIR 后重试"
        fi
    fi
    info "克隆项目到 $INSTALL_DIR ..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    NEED_BUILD=1
fi

# ============================
# 2. 安装依赖 & 构建
# ============================
step "2. 安装依赖 & 构建"

if [ -f "$INSTALL_DIR/node_modules/.package-lock.json" ] && [ -z "$NEED_BUILD" ]; then
    info "依赖已安装，跳过"
else
    info "安装依赖..."
    npm install --prefix "$INSTALL_DIR"
    NEED_BUILD=1
fi

if [ -f "$INSTALL_DIR/dist/cli.js" ] && [ -z "$NEED_BUILD" ]; then
    info "已构建，跳过"
else
    info "构建项目..."
    npm run build --prefix "$INSTALL_DIR"
fi

# ============================
# 3. 全局链接
# ============================
step "3. 全局链接"

if command -v claudetalk &>/dev/null && readlink -f "$(command -v claudetalk)" 2>/dev/null | grep -q "$INSTALL_DIR"; then
    info "claudetalk 已全局链接 ✓"
else
    info "全局链接 claudetalk..."
    npm link --prefix "$INSTALL_DIR"
fi

# ============================
# 4. 配置文件
# ============================
CONFIG_FILE="$INSTALL_DIR/.claudetalk.json"
step "4. 配置文件"

if [ -f "$CONFIG_FILE" ]; then
    info "配置文件已存在: $CONFIG_FILE"
    read -p "是否重新配置？[y/N]: " RECONFIG
    if [[ ! "$RECONFIG" =~ ^[Yy]$ ]]; then
        info "保留现有配置"
    fi
fi

if [ ! -f "$CONFIG_FILE" ] || [[ "$RECONFIG" =~ ^[Yy]$ ]]; then
    echo ""
    echo "请输入飞书应用凭据 (在飞书开发者后台 → 凭据与基础信息 页面获取)"
    read -p "FEISHU_APP_ID: " APP_ID
    read -p "FEISHU_APP_SECRET: " APP_SECRET

    if [ -z "$APP_ID" ] || [ -z "$APP_SECRET" ]; then
        error "APP_ID 和 APP_SECRET 不能为空"
    fi

    cat > "$CONFIG_FILE" <<EOF
{
  "profiles": {
    "default": {
      "channel": "feishu",
      "feishu": {
        "FEISHU_APP_ID": "$APP_ID",
        "FEISHU_APP_SECRET": "$APP_SECRET"
      },
      "systemPrompt": "你是 Claude Code AI 助手，帮助用户完成各种编程和软件工程任务。"
    }
  }
}
EOF
    info "配置文件已写入: $CONFIG_FILE"
fi

# ============================
# 5. 创建 systemd 服务
# ============================
step "5. 创建 systemd 服务"

NODE_BIN=$(readlink -f "$(command -v node)")
USER_NAME=$(whoami)
USER_HOME=$(eval echo "~$USER_NAME")

SERVICE_CONTENT="[Unit]
Description=ClaudeTalk - Feishu Bot for Claude Code
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$SCRIPT_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/dist/cli.js
Restart=always
RestartSec=5
Environment=PATH=$(dirname "$NODE_BIN"):/home/x/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production
Environment=CLAUDECODE=
Environment=HOME=$USER_HOME
Environment=CLAUDETALK_HOME=$INSTALL_DIR
StandardOutput=journal
StandardError=journal
SyslogIdentifier=claudetalk

[Install]
WantedBy=multi-user.target"

info "安装 systemd 服务 (需要 sudo)..."
echo "$SERVICE_CONTENT" | sudo tee /etc/systemd/system/claudetalk.service > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable claudetalk
sudo systemctl restart claudetalk

# ============================
# 6. 等待启动 & 检查
# ============================
sleep 2
if systemctl is-active --quiet claudetalk; then
    echo ""
    echo "========================================"
    info "ClaudeTalk 部署完成！"
    echo "========================================"
    echo ""
    info "文件布局:"
    echo "  仓库目录:  $INSTALL_DIR/"
    echo "  配置文件:  $INSTALL_DIR/.claudetalk.json"
    echo "  运行数据:  $INSTALL_DIR/.claudetalk/"
    echo "  会话文件:  $INSTALL_DIR/.claudetalk-sessions.json"
    echo "  工作目录:  $SCRIPT_DIR (Claude Code cwd)"
    echo ""
    info "常用命令:"
    echo "  查看状态:  $0 status"
    echo "  查看日志:  $0 logs"
    echo "  重启服务:  sudo systemctl restart claudetalk"
    echo "  停止服务:  sudo systemctl stop claudetalk"
    echo "  完全卸载:  $0 uninstall"
    echo ""
    warn "请确认飞书开发者后台已完成以下配置:"
    echo "  1. 权限管理 → 已开通 im:message, im:message:send_as_bot, im:chat, im:resource"
    echo "  2. 事件与回调 → 订阅方式为「长连接」，已添加 im.message.receive_v1 事件"
    echo "  3. 版本管理与发布 → 应用已发布"
    echo ""
else
    echo ""
    error "服务启动失败，请查看日志: journalctl -u claudetalk -n 30"
fi
