#!/bin/sh
# a2a-hub 一行安装与部署：
#   1) 全新 Mac mini / 服务器一键安装并启动独立 Hub：
#      curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --hub
#   2) 全新机器一键安装并接入已有 Hub（自动同步公钥与 Token）：
#      curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --join http://<token>@<hub-ip>:8787
#   3) 仅安装命令行工具（不立即配置）：
#      curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh
# 布局：~/.hub-node/ 是配置目录，~/.hub-node/app/ 是程序本体，
#       ~/.local/bin/lah 是主命令入口（同时提供 a2a-hub / ahub / hub-node 别名）。
set -eu

SKIP_SKILL="${LAH_SKIP_SKILL:-0}"
BOOTSTRAP_MODE=""
JOIN_URL=""
USE_SERVICE=1

n=$#
while [ "$n" -gt 0 ]; do
  arg=$1
  shift
  n=$((n - 1))
  case "$arg" in
    --skip-skill)
      SKIP_SKILL=1
      ;;
    --hub)
      BOOTSTRAP_MODE="hub"
      ;;
    --join)
      [ "$n" -gt 0 ] || { echo "install.sh: --join 需要 Hub URL 参数" >&2; exit 2; }
      BOOTSTRAP_MODE="join"
      JOIN_URL=$1
      shift
      n=$((n - 1))
      ;;
    --join=*)
      BOOTSTRAP_MODE="join"
      JOIN_URL=${arg#--join=}
      ;;
    --no-service)
      USE_SERVICE=0
      ;;
    -h|--help)
      echo "用法: install.sh [--hub | --join <url>] [--no-service] [--skip-skill] [setup flags...]"
      echo "  --hub         一键配置独立 SQLite Hub 并注册自启（等价于自动安装后运行 lah up --service）"
      echo "  --join <url>  一键接入已有独立 Hub 并注册自启（支持内嵌 token：http://<token>@<ip>:8787）"
      echo "  --no-service  仅生成配置并自检，不注册开机自启"
      echo "  --skip-skill  跳过自动安装 ~/.agents/skills/lah（也可设置环境变量 LAH_SKIP_SKILL=1）"
      exit 0
      ;;
    *)
      set -- "$@" "$arg"
      ;;
  esac
done

REPO_GIT="https://github.com/backtomyfuture/a2a-hub.git"
REPO_TAR="https://codeload.github.com/backtomyfuture/a2a-hub/tar.gz/refs/heads/main"
HOME_DIR="${HUB_NODE_HOME:-$HOME/.hub-node}"
APP="$HOME_DIR/app"

command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js >= 24" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || { echo "Node.js 版本过低（当前 $(node -v)），需要 >= 24" >&2; exit 1; }

mkdir -p "$HOME_DIR"

if [ -d "$APP/.git" ]; then
  echo "更新已有安装…"
  git -C "$APP" pull --ff-only
elif [ -e "$APP" ]; then
  echo "$APP 已存在但不是 git 检出，请先移走它再重跑" >&2
  exit 1
elif command -v git >/dev/null 2>&1; then
  git clone --depth 1 "$REPO_GIT" "$APP"
else
  echo "未找到 git，改用压缩包安装…"
  TMP="$(mktemp -d)"
  curl -fsSL "$REPO_TAR" | tar xz -C "$TMP"
  mv "$TMP"/a2a-hub-main "$APP"
  rm -rf "$TMP"
fi

cd "$APP"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
fi

chmod +x "$APP/bin/lah.mjs" "$APP/bin/hub-node.mjs"
mkdir -p "$HOME/.local/bin"
ln -sf "$APP/bin/lah.mjs" "$HOME/.local/bin/lah"
ln -sf "$APP/bin/lah.mjs" "$HOME/.local/bin/a2a-hub"
ln -sf "$APP/bin/lah.mjs" "$HOME/.local/bin/ahub"
ln -sf "$APP/bin/lah.mjs" "$HOME/.local/bin/hub-node"

# 自动安装 lah Skill 给终端 Agent 使用（可通过 --skip-skill 或 LAH_SKIP_SKILL=1 跳过）
if [ "$SKIP_SKILL" != "1" ] && [ "$SKIP_SKILL" != "true" ]; then
  mkdir -p "$HOME/.agents/skills/lah"
  if [ -f "$APP/skills/lah/SKILL.md" ]; then
    cp -f "$APP/skills/lah/SKILL.md" "$HOME/.agents/skills/lah/SKILL.md"
  fi
else
  echo "跳过安装 lah Skill（--skip-skill）"
  set -- "$@" "--skip-skill"
fi

if [ "$BOOTSTRAP_MODE" = "hub" ]; then
  if [ "$USE_SERVICE" = "1" ]; then
    set -- "$@" "--service"
  fi
  exec node "$APP/bin/lah.mjs" setup --role hub --bus sqlite --yes --auto-token "$@"
elif [ "$BOOTSTRAP_MODE" = "join" ]; then
  [ -n "$JOIN_URL" ] || { echo "install.sh: --join 缺少 Hub URL" >&2; exit 2; }
  if [ "$USE_SERVICE" = "1" ]; then
    set -- "$@" "--service"
  fi
  exec node "$APP/bin/lah.mjs" setup --role node --bus http --join "$JOIN_URL" --yes --force "$@"
fi

cat <<EOF

安装完成（零外部依赖，Node >= 24 即开即用）。接下来只需一条命令：
  1) 本机启动独立中台 Hub（Mac mini / 常驻主机）：
     lah up --service
  2) 其他机器一行接入已有 Hub：
     lah join http://[<token>@]<hub-ip>:8787 --service
  3) 飞书多维表格兼容模式 / 高级向导：
     lah setup --bus feishu
若 lah 命令找不到，请将 \$HOME/.local/bin 加入 PATH。
EOF
