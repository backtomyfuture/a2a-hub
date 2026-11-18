# a2a-hub Windows 一行安装与部署：
#   1) 仅安装命令行工具：
#      irm https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.ps1 | iex
#   2) 安装并一键接入已有 Hub：
#      $env:AH_JOIN="http://<token>@<hub-ip>:8787"; irm https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.ps1 | iex
# 布局：%USERPROFILE%\.hub-node\ 是配置目录，其下 app\ 是程序本体，
#       bin\ah.cmd、bin\a2a-hub.cmd、bin\ahub.cmd、bin\lah.cmd 与 bin\hub-node.cmd 是命令入口（加入当前用户 PATH）。
# Windows 不把无扩展名文件当命令，也不保证能建软链，所以入口是 cmd 包装，
# 用 %~dp0 相对路径指向 app\bin\ah.mjs，用户名含非 ASCII 时也不靠代码页。
# 不在这里写 node.json / commands.json。重跑本脚本 = 更新程序，已有配置不覆盖。
# 跳过 Skill：-SkipSkill / --skip-skill，或事先 $env:AH_SKIP_SKILL=1。
# 本文件不用 param()：irm | iex 会把顶层 param 当成命令，参数因此从 $args 读。
& {
  $ErrorActionPreference = "Stop"
  # git / npm 把进度写到 stderr。PowerShell 7 若把原生 stderr 当成错误，会把成功的克隆判失败。
  if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
  }

  $skipSkill = $false
  $showHelp = $false
  $bootstrapMode = ""
  $joinUrl = if (-not [string]::IsNullOrWhiteSpace($env:AH_JOIN)) { $env:AH_JOIN } else { $env:LAH_JOIN }
  $useService = $true
  $installForce = $false
  if (-not [string]::IsNullOrWhiteSpace($joinUrl)) {
    $bootstrapMode = "join"
  }
  if ($env:AH_SKIP_SKILL -eq "1" -or $env:AH_SKIP_SKILL -eq "true" -or $env:LAH_SKIP_SKILL -eq "1" -or $env:LAH_SKIP_SKILL -eq "true") {
    $skipSkill = $true
  }
  for ($idx = 0; $idx -lt $args.Length; $idx++) {
    $arg = [string]$args[$idx]
    switch -Regex ($arg) {
      "^(-h|--help|-Help)$" { $showHelp = $true }
      "^(--skip-skill|-SkipSkill)$" { $skipSkill = $true }
      "^(--no-service|-NoService)$" { $useService = $false }
      "^(--force|-Force)$" { $installForce = $true }
      "^(--hub|-Hub)$" { $bootstrapMode = "hub" }
      "^(--join|-Join)$" {
        if ($idx + 1 -ge $args.Length) { throw "--join 需要 Hub URL 参数" }
        $bootstrapMode = "join"
        $joinUrl = [string]$args[++$idx]
      }
      "^--join=(.+)$" {
        $bootstrapMode = "join"
        $joinUrl = $Matches[1]
      }
    }
  }

  if ($showHelp) {
    Write-Host "用法: install.ps1 [-Hub | -Join <url>] [-NoService] [-SkipSkill] [-Force]"
    Write-Host "      irm https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.ps1 | iex"
    Write-Host "  -Hub, --hub               安装后立即配置独立 SQLite Hub 并注册开机任务"
    Write-Host "  -Join, --join <url>       安装后立即接入已有 Hub 并注册开机任务（也可用 `$env:AH_JOIN）"
    Write-Host "  -NoService, --no-service  仅配置与自检，不注册开机任务"
    Write-Host "  -SkipSkill, --skip-skill  跳过安装 %USERPROFILE%\.agents\skills\ah"
    Write-Host "  -Force, --force           已有旧版飞书 node.json 时仍覆盖。默认拒绝，以免拆掉正在运行的 lark-a2a-hub"
    Write-Host "已装旧版 lark-a2a-hub 时请用独立目录，例如："
    Write-Host '  $env:HUB_NODE_HOME = "$env:USERPROFILE\.a2a-hub"; irm https://raw.githubusercontent.com/backtomyfuture/a2a-hub/main/install.ps1 | iex'
    return
  }

  if ($env:OS -ne "Windows_NT") {
    throw "install.ps1 用于 Windows。macOS / Linux 请运行 install.sh。"
  }

  function Invoke-Native {
    param([string]$File, [string[]]$ArgumentList)
    # 调用处必须写 -ArgumentList，不能把数组拆开传：否则只有第一个参数进得来。
    & $File @ArgumentList
    if ($LASTEXITCODE -ne 0) {
      throw "$File 失败，退出码 $LASTEXITCODE"
    }
  }

  function Test-PathEntry {
    param([string]$Raw, [string]$Dir)
    if ([string]::IsNullOrWhiteSpace($Raw)) { return $false }
    $norm = $Dir.TrimEnd("\")
    foreach ($part in ($Raw -split ";")) {
      $p = $part.Trim().Trim('"').TrimEnd("\")
      if ($p -and ($p -ieq $norm)) { return $true }
    }
    return $false
  }

  # 只认本仓库。大小写、https/ssh、有无 .git 后缀都算；不打印 origin，地址里可能嵌了凭据。
  function Test-A2aHubOrigin {
    param([string]$Origin)
    if ([string]::IsNullOrWhiteSpace($Origin)) { return $false }
    $raw = $Origin.Trim().TrimEnd("/")
    return $raw -match '^(https?|ssh)://([^@/]+@)?github\.com/backtomyfuture/a2a-hub(\.git)?$|^git@github\.com:backtomyfuture/a2a-hub(\.git)?$'
  }

  # 与 src/setup.mjs 的 isLegacyFeishuNodeConfig 同一口径。退出码 10 是旧飞书配置，11 是无法解析。
  function Get-LegacyConfigStatus {
    param([string]$NodeJson, [string]$NodeExe)
    $code = 'const fs=require("node:fs"); let raw; try { raw=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); } catch { process.exit(11); } if (!raw || typeof raw !== "object" || Array.isArray(raw)) process.exit(11); const bus=String(raw.busType??"").trim().toLowerCase(); const keys=["baseToken","appId","appSecret","verificationToken","encryptKey","appToken"]; const has=keys.some((k)=>Object.hasOwn(raw,k)&&raw[k]!=null&&String(raw[k]).trim()!==""); const inferred=Boolean(raw.hubUrl||raw.dbPath||raw.listen); if (bus==="feishu" || (!bus && !inferred) || has) process.exit(10); process.exit(0);'
    & $NodeExe -e $code $NodeJson
    if ($null -eq $LASTEXITCODE) { return 11 }
    return $LASTEXITCODE
  }

  # 返回 added / present / manual。当前进程的 PATH 能补就补，让本次窗口立刻能跑 ah。
  function Add-UserPathEntry {
    param([string]$Dir)
    $userRaw = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($null -eq $userRaw) { $userRaw = "" }
    $machineRaw = [Environment]::GetEnvironmentVariable("Path", "Machine")
    if ($null -eq $machineRaw) { $machineRaw = "" }

    if (-not (Test-PathEntry $env:Path $Dir)) {
      if ([string]::IsNullOrWhiteSpace($env:Path)) { $env:Path = $Dir }
      else { $env:Path = $env:Path.TrimEnd(";") + ";" + $Dir }
    }
    if ((Test-PathEntry $userRaw $Dir) -or (Test-PathEntry $machineRaw $Dir)) {
      return "present"
    }

    $updated = $userRaw.Trim().TrimEnd(";")
    if ($updated -eq "") { $updated = $Dir } else { $updated = $updated + ";" + $Dir }
    # 用户 PATH 过长时注册表写入可能被旧工具截断，留给用户自己加。
    if ($updated.Length -gt 2047) {
      Write-Host "用户 PATH 过长，请手动加入：$Dir"
      return "manual"
    }
    [Environment]::SetEnvironmentVariable("Path", $updated, "User")
    return "added"
  }

  function Broadcast-EnvironmentChange {
    try {
      if (-not ("LahWin32.Native" -as [type])) {
        Add-Type -Namespace LahWin32 -Name Native -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
      }
      $broadcastResult = [UIntPtr]::Zero
      [LahWin32.Native]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$broadcastResult) | Out-Null
    } catch {
      Write-Host "未能通知其它窗口刷新 PATH。新开一个终端后再运行 ah。"
    }
  }

  $nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $nodeCmd) {
    throw "需要先安装 Node.js >= 24：https://nodejs.org"
  }
  $nodeVer = (& $nodeCmd.Source -p "process.versions.node")
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($nodeVer)) {
    throw "无法读取 Node.js 版本"
  }
  $nodeVer = $nodeVer.Trim()
  $nodeMajor = [int]($nodeVer.Split(".")[0])
  if ($nodeMajor -lt 24) {
    throw "Node.js 版本过低（当前 v$nodeVer），需要 >= 24"
  }

  $npmCmd = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $npmCmd) {
    $npmCmd = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  }
  $npmExe = $null
  if ($npmCmd) { $npmExe = $npmCmd.Source }
  if (-not $npmExe) {
    $npmBeside = Join-Path (Split-Path -Parent $nodeCmd.Source) "npm.cmd"
    if (Test-Path -LiteralPath $npmBeside) { $npmExe = $npmBeside }
  }

  $profileHome = $env:USERPROFILE
  if ([string]::IsNullOrWhiteSpace($profileHome)) {
    $profileHome = [Environment]::GetFolderPath("UserProfile")
  }
  if ([string]::IsNullOrWhiteSpace($profileHome)) {
    throw "无法确定用户目录（USERPROFILE 为空）"
  }

  $repoGit = "https://github.com/backtomyfuture/a2a-hub.git"
  $repoTar = "https://codeload.github.com/backtomyfuture/a2a-hub/tar.gz/refs/heads/main"
  $configHome = $env:HUB_NODE_HOME
  if ([string]::IsNullOrWhiteSpace($configHome)) {
    $configHome = Join-Path $profileHome ".hub-node"
  }
  $app = Join-Path $configHome "app"
  $binDir = Join-Path $configHome "bin"

  New-Item -ItemType Directory -Force -Path $configHome | Out-Null
  $skipFetch = $env:AH_INSTALL_SKIP_FETCH -eq "1"

  if (Test-Path -LiteralPath (Join-Path $app ".git")) {
    $originText = ""
    try { $originText = [string](& git -C $app remote get-url origin) } catch { $originText = "" }
    if (-not (Test-A2aHubOrigin $originText)) {
      throw "检测到 $app 是旧版或其他项目的 git 检出（origin 不是 backtomyfuture/a2a-hub）。不会更新它，也不会修改配置或命令入口。请改用独立目录：`$env:HUB_NODE_HOME = `"`$env:USERPROFILE\.a2a-hub`""
    }
    if ($skipFetch) {
      Write-Host "跳过 git pull（AH_INSTALL_SKIP_FETCH）。"
    } else {
      Write-Host "更新已有安装…"
      Invoke-Native -File "git" -ArgumentList @("-C", $app, "pull", "--ff-only")
    }
  } elseif (Test-Path -LiteralPath $app) {
    if (-not $skipFetch) {
      throw "$app 已存在但不是 git 检出，请先移走它再重跑"
    }
    Write-Host "跳过获取代码（AH_INSTALL_SKIP_FETCH），使用已有目录。"
  } elseif ($skipFetch) {
    throw "AH_INSTALL_SKIP_FETCH=1 但 $app 不存在，无法跳过获取代码"
  } elseif (Get-Command git -CommandType Application -ErrorAction SilentlyContinue) {
    Invoke-Native -File "git" -ArgumentList @("clone", "--depth", "1", $repoGit, $app)
  } else {
    $curl = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $tar = Get-Command tar.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $curl -or -not $tar) {
      throw "未找到 git，且缺少 curl.exe 或 tar.exe。请安装 Git，或使用 Windows 10 及以上自带的 curl / tar。"
    }
    Write-Host "未找到 git，改用压缩包安装…"
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("lah-install-" + [Guid]::NewGuid().ToString("n"))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
      $tarFile = Join-Path $tmp "src.tar.gz"
      Invoke-Native -File $curl.Source -ArgumentList @("-fsSL", $repoTar, "-o", $tarFile)
      Invoke-Native -File $tar.Source -ArgumentList @("-xzf", $tarFile, "-C", $tmp)
      $extracted = Join-Path $tmp "a2a-hub-main"
      if (-not (Test-Path -LiteralPath $extracted)) {
        throw "压缩包里没有 a2a-hub-main"
      }
      Move-Item -LiteralPath $extracted -Destination $app
    } finally {
      if (Test-Path -LiteralPath $tmp) {
        Remove-Item -LiteralPath $tmp -Recurse -Force
      }
    }
  }

  if (-not $skipFetch) {
    Push-Location -LiteralPath $app
    try {
      if ((Test-Path -LiteralPath (Join-Path $app "package-lock.json")) -and $npmExe) {
        Invoke-Native -File $npmExe -ArgumentList @("ci", "--omit=dev", "--no-audit", "--no-fund")
      }
    } finally {
      Pop-Location
    }
  }

  $entryMjs = Join-Path $app "bin\ah.mjs"
  if (-not (Test-Path -LiteralPath $entryMjs)) {
    throw "安装结果里没有 $entryMjs，已停止。这通常表示目录不是 a2a-hub（旧版 lark-a2a-hub 没有该文件）。未修改配置与命令入口。"
  }

  if (-not [string]::IsNullOrEmpty($bootstrapMode)) {
    $nodeJson = Join-Path $configHome "node.json"
    if (Test-Path -LiteralPath $nodeJson) {
      $legacyStatus = Get-LegacyConfigStatus -NodeJson $nodeJson -NodeExe $nodeCmd.Source
      if ($legacyStatus -eq 10 -and -not $installForce) {
        throw "检测到旧版飞书总线配置（$nodeJson）。不会覆盖它。请改用独立目录：`$env:HUB_NODE_HOME = `"`$env:USERPROFILE\.a2a-hub`" 。确认可以废弃这份配置时再加 -Force。未打印配置内容。"
      }
      if ($legacyStatus -eq 10 -and $installForce) {
        Write-Host "已指定 -Force，将允许覆盖现有 node.json。未打印配置内容。"
      } elseif ($legacyStatus -ne 0) {
        throw "无法解析 $nodeJson，已停止，避免误覆盖。未打印文件内容。"
      }
    }
  }

  # 五个入口都进 ah.mjs（保留 lah.cmd / hub-node.cmd 向下兼容）。
  # lah / hub-node 若已指向别的程序则保留，避免把旧版 lark-a2a-hub 的命令劫持走。
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $shim = "@echo off`r`nnode `"%~dp0..\app\bin\ah.mjs`" %*`r`n"
  foreach ($name in @("ah.cmd", "a2a-hub.cmd", "ahub.cmd", "lah.cmd", "hub-node.cmd")) {
    $dest = Join-Path $binDir $name
    $guarded = $name -eq "lah.cmd" -or $name -eq "hub-node.cmd"
    if ($guarded -and (Test-Path -LiteralPath $dest)) {
      $existingShim = [System.IO.File]::ReadAllText($dest)
      if ($existingShim -notlike "*app\bin\ah.mjs*" -and $existingShim -notlike "*app/bin/ah.mjs*") {
        Write-Host "警告：保留已有命令 $dest（它不是本次安装的入口，未覆盖）。"
        continue
      }
    }
    [System.IO.File]::WriteAllText($dest, $shim, [System.Text.UTF8Encoding]::new($false))
  }

  $pathState = Add-UserPathEntry $binDir
  if ($pathState -eq "added") {
    Broadcast-EnvironmentChange
  }

  if (-not $skipSkill) {
    # 仅纯安装 CLI 时预装控制端 ah Skill；带 -Hub/-Join 时由随后的 ah setup 按角色与形态安装对应 Skill
    if ([string]::IsNullOrEmpty($bootstrapMode)) {
      $skillDir = Join-Path $profileHome ".agents\skills\ah"
      $skillSrc = Join-Path $app "skills\ah\SKILL.md"
      if (Test-Path -LiteralPath $skillSrc) {
        New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
        Copy-Item -LiteralPath $skillSrc -Destination (Join-Path $skillDir "SKILL.md") -Force
      }
    }
  } else {
    Write-Host "跳过安装 Skill（-SkipSkill）"
  }

  if ($bootstrapMode -eq "hub") {
    $setupArgs = @($entryMjs, "setup", "--role", "hub", "--bus", "sqlite", "--yes", "--auto-token")
    if ($useService) { $setupArgs += "--service" }
    if ($skipSkill) { $setupArgs += "--skip-skill" }
    if ($installForce) { $setupArgs += "--force" }
    Invoke-Native -File $nodeCmd.Source -ArgumentList $setupArgs
    return
  }
  if ($bootstrapMode -eq "join") {
    if ([string]::IsNullOrWhiteSpace($joinUrl)) { throw "-Join 缺少 Hub URL" }
    $setupArgs = @($entryMjs, "setup", "--role", "node", "--bus", "http", "--join", $joinUrl, "--yes", "--force")
    if ($useService) { $setupArgs += "--service" }
    if ($skipSkill) { $setupArgs += "--skip-skill" }
    Invoke-Native -File $nodeCmd.Source -ArgumentList $setupArgs
    return
  }

  Write-Host ""
  Write-Host "安装完成（零外部依赖）。接下来只需一条命令："
  Write-Host "  1) 本机启动独立中台 Hub：         ah up --service"
  Write-Host "  2) 接入已有 Hub：                 ah join http://[<token>@]<hub-ip>:8787 --service"
  Write-Host "  3) 自定义交互配置向导：           ah setup"
  Write-Host "命令入口：$binDir"
  Write-Host "若本机已有旧版 lark-a2a-hub，请把配置放到独立目录再执行 ah up，例如：`$env:HUB_NODE_HOME = `"`$env:USERPROFILE\.a2a-hub`"; ah up --service"
  if ($pathState -eq "added") {
    Write-Host "已加入用户 PATH。用 iex 跑的当前窗口可以直接试 ah；单独开的窗口请新开一个终端。"
  } elseif ($pathState -eq "manual") {
    Write-Host "请把上面的目录加入 PATH 后再运行 ah。"
  }
  Write-Host "向导问到开机自启时直接回车即可：会注册当前用户的任务计划程序任务，登录时启动，无需管理员。"
} @args
