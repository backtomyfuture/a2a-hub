#!/bin/sh
# a2a-hub 一行安装与部署（无需事先 git clone / 安装 Node）：
#   1) 全新 Mac / Linux 一键安装并启动独立 Hub：
#      curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --hub
#   2) 全新电脑一键安装并接入已有 Hub（自动装 Node 24 + ah + 探测 26 种 CLI + 后台自启）：
#      curl -fsSL https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.sh | sh -s -- --join "http://<token>@<hub-ip>:8787" --device mac-mini
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
      echo "用法: install.sh [--hub | --join <url>] [--device <id>] [--no-service] [--skip-skill] [setup flags...]"
      echo "  --hub         一键安装并启动独立 SQLite Hub（默认注册开机自启，等价于 ah up --service）"
      echo "  --join <url>  一键安装并挂载当前电脑到已有 Hub（等价于 ah join <url> --service）"
      echo "  --no-service  仅生成配置并在前台运行，不注册开机自启"
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

# 没有 node 或版本过低时，把官方 Node 24 LTS 装进家目录（不需要 root），而不是直接失败。
node_major_of() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

install_node24() {
  os_name="$(uname -s)"
  arch_name="$(uname -m)"
  case "$os_name:$arch_name" in
    Linux:x86_64) node_plat="linux-x64" ;;
    Linux:aarch64|Linux:arm64) node_plat="linux-arm64" ;;
    Darwin:arm64) node_plat="darwin-arm64" ;;
    Darwin:x86_64) node_plat="darwin-x64" ;;
    *)
      echo "不支持自动安装 Node.js 的平台（${os_name} ${arch_name}），请手动安装 Node.js >= 24：https://nodejs.org/" >&2
      exit 1
      ;;
  esac

  LOCAL_DIR="$HOME/.local"
  mkdir -p "$LOCAL_DIR/bin"

  # 幂等：~/.local/bin/node 已是 >=24 就不再下载。
  if [ -x "$LOCAL_DIR/bin/node" ] && [ "$(node_major_of "$LOCAL_DIR/bin/node")" -ge 24 ]; then
    PATH="$LOCAL_DIR/bin:$PATH"
    export PATH
    return 0
  fi

  command -v curl >/dev/null 2>&1 || { echo "自动安装 Node.js 需要 curl，请先安装 curl 或手动安装 Node.js >= 24" >&2; exit 1; }
  NODE_DIST="https://nodejs.org/dist/latest-v24.x"
  echo "未找到 Node.js >= 24，正在安装官方 Node 24 LTS（${node_plat}）到 ${LOCAL_DIR}…"
  sums="$(curl -fsSL "$NODE_DIST/SHASUMS256.txt")" || { echo "下载 Node.js 校验清单失败：${NODE_DIST}/SHASUMS256.txt" >&2; exit 1; }
  line="$(printf '%s\n' "$sums" | grep -E "  node-v24\.[0-9.]+-${node_plat}\.tar\.gz\$" | head -n 1)" || line=
  [ -n "$line" ] || { echo "校验清单里没有 ${node_plat} 的 Node 24 安装包，请手动安装 Node.js >= 24" >&2; exit 1; }
  node_file="${line##* }"

  ntmp="$(mktemp -d)"
  curl -fsSL -o "$ntmp/$node_file" "$NODE_DIST/$node_file" || { rm -rf "$ntmp"; echo "下载 Node.js 失败：${NODE_DIST}/${node_file}" >&2; exit 1; }
  printf '%s\n' "$line" > "$ntmp/SHASUM"
  if command -v shasum >/dev/null 2>&1; then
    (cd "$ntmp" && shasum -a 256 -c SHASUM >/dev/null) || { rm -rf "$ntmp"; echo "Node.js 安装包 sha256 校验失败，已停止" >&2; exit 1; }
  elif command -v sha256sum >/dev/null 2>&1; then
    (cd "$ntmp" && sha256sum -c SHASUM >/dev/null) || { rm -rf "$ntmp"; echo "Node.js 安装包 sha256 校验失败，已停止" >&2; exit 1; }
  else
    rm -rf "$ntmp"
    echo "未找到 shasum / sha256sum，无法校验 Node.js 安装包，已停止" >&2
    exit 1
  fi

  mkdir -p "$LOCAL_DIR/node-v24"
  tar xzf "$ntmp/$node_file" -C "$LOCAL_DIR/node-v24" || { rm -rf "$ntmp"; echo "解压 Node.js 安装包失败" >&2; exit 1; }
  rm -rf "$ntmp"
  ln -sfn "$LOCAL_DIR/node-v24/${node_file%.tar.gz}" "$LOCAL_DIR/node"
  for bin_name in node npm npx; do
    if [ -e "$LOCAL_DIR/node/bin/$bin_name" ]; then
      ln -sf "$LOCAL_DIR/node/bin/$bin_name" "$LOCAL_DIR/bin/$bin_name"
    fi
  done
  PATH="$LOCAL_DIR/bin:$PATH"
  export PATH
  echo "已安装 Node.js $(node -v) 到 ${LOCAL_DIR}/node。非登录 shell（如 runtime hook）需在 PATH 前加 ${LOCAL_DIR}/bin。"
}

if ! command -v node >/dev/null 2>&1 || [ "$(node_major_of node)" -lt 24 ]; then
  install_node24
fi
NODE_MAJOR="$(node_major_of node)"
[ "$NODE_MAJOR" -ge 24 ] || { echo "Node.js 版本过低（当前 $(node -v 2>/dev/null || echo 未知)），需要 >= 24" >&2; exit 1; }

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
  exec node "$APP/bin/ah.mjs" up "$@"
elif [ "$BOOTSTRAP_MODE" = "join" ]; then
  [ -n "$JOIN_URL" ] || { echo "install.sh: --join 缺少 Hub URL" >&2; exit 2; }
  if [ "$USE_SERVICE" = "1" ]; then
    set -- "$@" "--service"
  fi
  exec node "$APP/bin/ah.mjs" join "$JOIN_URL" "$@"
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
