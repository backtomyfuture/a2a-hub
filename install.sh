#!/bin/sh
# a2a-hub 一行安装与部署：
#   1) 全新 Mac mini / 服务器一键安装并启动独立 Hub：
#      curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --hub
#   2) 全新机器一键安装并接入已有 Hub（自动同步公钥与 Token）：
#      curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --join http://<token>@<hub-ip>:8787
#   3) 仅安装命令行工具（不立即配置）：
#      curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh
# 布局：~/.a2a-hub/ 是配置目录（可用 AH_HOME 改），~/.a2a-hub/app/ 是程序本体，
#       ~/.local/bin/ah 是主命令入口（同时提供 a2a-hub / ahub 别名）。
# AH_INSTALL_SKIP_FETCH=1：测试或不触网重入时跳过 clone / pull / npm。生产安装不要设置。
set -eu

SKIP_SKILL="${AH_SKIP_SKILL:-0}"
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
      echo "  --hub         一键配置独立 SQLite Hub 并注册自启（等价于自动安装后运行 ah up --service）"
      echo "  --join <url>  一键接入已有独立 Hub 并注册自启（支持内嵌 token：http://<token>@<ip>:8787）"
      echo "  --no-service  仅生成配置并自检，不注册开机自启"
      echo "  --skip-skill  跳过自动安装 ~/.agents/skills/ah（也可设置环境变量 AH_SKIP_SKILL=1）"
      echo "配置目录：AH_HOME，缺省 \$HOME/.a2a-hub。"
      exit 0
      ;;
    *)
      set -- "$@" "$arg"
      ;;
  esac
done

REPO_GIT="https://github.com/backtomyfuture/a2a-hub.git"
REPO_TAR="https://codeload.github.com/backtomyfuture/a2a-hub/tar.gz/refs/heads/main"
HOME_DIR="${AH_HOME:-$HOME/.a2a-hub}"
APP="$HOME_DIR/app"

command -v node >/dev/null 2>&1 || { echo "需要先安装 Node.js >= 24" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || { echo "Node.js 版本过低（当前 $(node -v)），需要 >= 24" >&2; exit 1; }

# 只认本仓库。大小写、https/ssh、有无 .git 后缀都算。不打印 origin：地址里可能嵌了凭据。
is_a2a_hub_origin() {
  node -e '
    const raw = String(process.argv[1] || "").trim().replace(/\/+$/, "");
    const ok = /^((https?|ssh):\/\/([^@/]+@)?github\.com\/|git@github\.com:)backtomyfuture\/a2a-hub(\.git)?$/i.test(raw);
    process.exit(ok ? 0 : 1);
  ' "$1"
}

fetch_skipped() {
  [ "${AH_INSTALL_SKIP_FETCH:-}" = "1" ]
}

refuse_foreign_checkout() {
  cat >&2 <<EOF
检测到 ${APP} 已是 git 检出，但 origin 不是 backtomyfuture/a2a-hub。
不会更新它，也不会修改配置目录或命令软链。
请换一个配置目录后再安装（环境变量 AH_HOME）。
EOF
  exit 1
}

warn_path() {
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) return 0 ;;
  esac
  cat <<EOF

当前 PATH 没有 \$HOME/.local/bin，新开的终端会找不到 ah。可以执行：
  # zsh
  echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.zshrc && . ~/.zshrc
  # bash
  echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.bashrc && . ~/.bashrc
EOF
}

mkdir -p "$HOME_DIR"

if [ -d "$APP/.git" ]; then
  origin=$(git -C "$APP" remote get-url origin 2>/dev/null) || origin=
  if ! is_a2a_hub_origin "$origin"; then
    refuse_foreign_checkout
  fi
  if fetch_skipped; then
    echo "跳过 git pull（AH_INSTALL_SKIP_FETCH）。"
  else
    echo "更新已有安装…"
    git -C "$APP" pull --ff-only
  fi
elif [ -e "$APP" ]; then
  if fetch_skipped; then
    echo "跳过获取代码（AH_INSTALL_SKIP_FETCH），使用已有目录。"
  else
    echo "${APP} 已存在但不是 git 检出，请先移走它再重跑" >&2
    exit 1
  fi
elif fetch_skipped; then
  echo "AH_INSTALL_SKIP_FETCH=1 但 ${APP} 不存在，无法跳过获取代码" >&2
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
if ! fetch_skipped && [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
fi

if [ ! -f "$APP/bin/ah.mjs" ]; then
  echo "安装结果里没有 ${APP}/bin/ah.mjs，已停止。未修改配置与命令软链。" >&2
  exit 1
fi
chmod +x "$APP/bin/ah.mjs"

mkdir -p "$HOME/.local/bin"
for name in ah a2a-hub ahub; do
  ln -sf "$APP/bin/ah.mjs" "$HOME/.local/bin/$name"
done

# 仅纯安装 CLI 时预装控制端 ah Skill；带 --hub/--join 时由随后的 ah setup 按角色与宿主形态精准安装
if [ "$SKIP_SKILL" != "1" ] && [ "$SKIP_SKILL" != "true" ]; then
  if [ -z "$BOOTSTRAP_MODE" ]; then
    mkdir -p "$HOME/.agents/skills/ah"
    if [ -f "$APP/skills/ah/SKILL.md" ]; then
      cp -f "$APP/skills/ah/SKILL.md" "$HOME/.agents/skills/ah/SKILL.md"
    fi
  fi
else
  echo "跳过安装 Skill（--skip-skill）"
  set -- "$@" "--skip-skill"
fi

warn_path

if [ "$BOOTSTRAP_MODE" = "hub" ]; then
  if [ "$USE_SERVICE" = "1" ]; then
    set -- "$@" "--service"
  fi
  exec node "$APP/bin/ah.mjs" setup --role hub --bus sqlite --yes --auto-token "$@"
elif [ "$BOOTSTRAP_MODE" = "join" ]; then
  [ -n "$JOIN_URL" ] || { echo "install.sh: --join 缺少 Hub URL" >&2; exit 2; }
  if [ "$USE_SERVICE" = "1" ]; then
    set -- "$@" "--service"
  fi
  # 与 ah join 一致：重复接入要刷新地址、Token 与公钥。
  exec node "$APP/bin/ah.mjs" setup --role node --bus http --join "$JOIN_URL" --yes --force "$@"
fi

cat <<EOF

安装完成（零外部依赖，Node >= 24 即开即用）。接下来只需一条命令：
  1) 本机启动独立中台 Hub（Mac mini / 常驻主机）：
     ah up --service
  2) 其他机器一行接入已有 Hub：
     ah join http://[<token>@]<hub-ip>:8787 --service
  3) 纯 HTTP Agent（如 Muse / Grok Bot）接入发现端点：
     GET http://<hub-ip>:8787/.well-known/agent.json
配置目录：${HOME_DIR}（可用 AH_HOME 指定）。
EOF
