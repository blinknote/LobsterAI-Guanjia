# PowerShell helper for CircleCI Windows x64 build with hard wall process timeouts
param(
    [Parameter(Position = 0)]
    [string]$Action = "all"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Every CircleCI PowerShell step starts with a fresh process environment.
$nodeDir = "C:\tools\node-v24.15.0-win-x64"
$env:PATH = "$nodeDir;$env:PATH"
$env:NPM_CONFIG_PREFIX = $nodeDir
$env:NPM_CONFIG_CACHE = "C:\lobsterai-cache\npm"
$env:ELECTRON_CACHE = "C:\lobsterai-cache\electron"
$env:ELECTRON_BUILDER_CACHE = "C:\lobsterai-cache\electron-builder"
$env:LOBSTERAI_PNPM_STORE = "C:\lobsterai-cache\pnpm-store"

# Artifact-only CI builds must never inherit certificate signing credentials.
Get-ChildItem Env: | Where-Object { $_.Name -like "CSC_*" -or $_.Name -like "WIN_CSC_*" } | ForEach-Object {
    Remove-Item -LiteralPath "Env:$($_.Name)"
}
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
$env:LOBSTERAI_UNSIGNED_WINDOWS = "1"

# Never cached. The absolute job deadline also charges cache/workspace waits.
$budgetFile = Join-Path $PSScriptRoot ".windows-build-deadline.json"
$script:deadlineUtc = [DateTime]::MinValue

function Initialize-BuildBudget {
    @{ deadlineUtc = [DateTime]::UtcNow.AddMinutes(55).ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $budgetFile -Encoding UTF8
    Write-Host "==> $([DateTime]::UtcNow.ToString('o')) Initialized absolute job budget: 55m"
}

function Invoke-CommandWithHardTimeout {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [Parameter(Mandatory = $true)]
        [int]$TimeoutMinutes,
        [string]$WorkingDirectory = $PWD.Path,
        [string]$Executable = "cmd.exe"
    )

    $remainingMs = [Math]::Floor(($script:deadlineUtc - [DateTime]::UtcNow).TotalMilliseconds)
    if ($remainingMs -le 0) { throw "55-minute absolute job budget exhausted before: $Command" }
    $timeoutMs = [int][Math]::Min($TimeoutMinutes * 60 * 1000, $remainingMs)
    $startedUtc = [DateTime]::UtcNow
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $outcome = "failed"
    Write-Host "==> $($startedUtc.ToString('o')) Starting command (limit: $timeoutMs ms, stage cap: ${TimeoutMinutes}m): $Command"

    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = $Executable
    $pinfo.Arguments = if ($Executable -eq "cmd.exe") { "/c $Command" } else { $Command }
    $pinfo.WorkingDirectory = $WorkingDirectory
    $pinfo.UseShellExecute = $false

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $pinfo

    $started = $false
    try {
        $started = $proc.Start()
        if (-not $started) {
            throw "Failed to start process for command: $Command"
        }
        $exited = $proc.WaitForExit($timeoutMs)
        if (-not $exited) {
            throw "Command execution timed out after $timeoutMs ms (stage or job deadline): $Command"
        }
        if ($proc.ExitCode -ne 0) {
            throw "Command failed with exit code $($proc.ExitCode): $Command"
        }
        $outcome = "succeeded"
    } finally {
        try {
            if ($started -and -not $proc.HasExited -and $proc.Id -gt 0 -and $proc.Id -ne $PID) {
                Write-Warning "Terminating owned process tree $($proc.Id)."
                $killer = Start-Process -FilePath "taskkill.exe" -ArgumentList "/PID $($proc.Id) /T /F" -NoNewWindow -PassThru
                try {
                    if (-not $killer.WaitForExit(10000)) {
                        $killer.Kill()
                        Write-Warning "Owned-tree cleanup exceeded 10 seconds."
                    } elseif ($killer.ExitCode -ne 0) {
                        Write-Warning "taskkill failed with exit code $($killer.ExitCode)."
                    }
                } finally {
                    $killer.Dispose()
                }
            }
        } finally {
            $proc.Dispose()
            $timer.Stop()
            Write-Host "==> $([DateTime]::UtcNow.ToString('o')) Command $outcome; duration=$($timer.Elapsed.TotalSeconds.ToString('F3'))s: $Command"
        }
    }
}

function Install-NodeToolchain {
    # Run the complete setup in one bounded child, not via recursive action dispatch.
    $setup = {
    Set-StrictMode -Version Latest
    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"
    $nodeVersion = "24.15.0"
    $expectedSha256 = "cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62"
    $toolsDir = "C:\tools"
    $nodeDir = Join-Path $toolsDir "node-v$nodeVersion-win-x64"
    $zipPath = Join-Path $toolsDir "node.zip"

    if (-not (Test-Path $toolsDir)) {
        New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
    }

    if (-not (Test-Path (Join-Path $nodeDir "node.exe"))) {
        $url = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
        Write-Host "==> Downloading Node $nodeVersion from $url..."
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zipPath -TimeoutSec 300

        Write-Host "==> Verifying SHA256 checksum..."
        $actualSha = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualSha -ne $expectedSha256.ToLowerInvariant()) {
            throw "Node SHA256 mismatch! Expected: $expectedSha256, Actual: $actualSha"
        }
        Write-Host "==> SHA256 matched successfully."

        Write-Host "==> Extracting Node archive..."
        Expand-Archive -Path $zipPath -DestinationPath $toolsDir -Force
        Remove-Item -Force $zipPath
    }

    Write-Host "==> Verifying Node & npm versions..."
    $nodeVersionActual = (& node.exe -v).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Node version check failed." }
    if ($nodeVersionActual -ne "v$nodeVersion") { throw "Expected Node v$nodeVersion, got $nodeVersionActual." }
    $npmVer = (& npm.cmd -v).Trim()
    if ($LASTEXITCODE -ne 0) { throw "npm version check failed." }
    Write-Host "==> Bundled npm version: $npmVer"

    if ($npmVer -ne "11.17.0") {
        Write-Host "==> Updating npm to 11.17.0..."
        & npm.cmd install --global --prefix $nodeDir npm@11.17.0
        if ($LASTEXITCODE -ne 0) { throw "npm installation failed." }
        $npmVer = (& npm.cmd -v).Trim()
        if ($LASTEXITCODE -ne 0) { throw "npm version check failed." }
    }
    if ($npmVer -ne "11.17.0") { throw "Expected npm 11.17.0, got $npmVer." }

    # Reuse a validated native pnpm from the toolchain cache.
    $pnpmVersion = ""
    if (Test-Path (Join-Path $nodeDir "pnpm.cmd")) {
        $pnpmVersion = (& pnpm.cmd --version).Trim()
        if ($LASTEXITCODE -ne 0) { $pnpmVersion = "" }
    }
    if ($pnpmVersion -ne "12.1.0") {
        Write-Host "==> Installing pnpm 12.1.0..."
        & npm.cmd install --global --prefix $nodeDir pnpm@12.1.0
        if ($LASTEXITCODE -ne 0) { throw "pnpm installation failed." }
    }
    $pnpmVersion = (& pnpm.cmd --version).Trim()
    if ($LASTEXITCODE -ne 0) { throw "pnpm version check failed." }
    if ($pnpmVersion -ne "12.1.0") { throw "Expected pnpm 12.1.0, got $pnpmVersion." }
    Write-Host "==> pnpm version: $pnpmVersion"
    # pnpm 12 uses camelCase settings in its global config, not npm env settings.
    # Reapply once per job even on a toolchain cache hit; the config is not cached.
    & pnpm.cmd config set --global storeDir $env:LOBSTERAI_PNPM_STORE
    if ($LASTEXITCODE -ne 0) { throw "pnpm store configuration failed." }
    $storePath = (& pnpm.cmd store path).Trim()
    if ($LASTEXITCODE -ne 0) { throw "pnpm store path check failed." }
    $storeRoot = [IO.Path]::GetFullPath($env:LOBSTERAI_PNPM_STORE).TrimEnd('\')
    $actualStore = [IO.Path]::GetFullPath($storePath).TrimEnd('\')
    if ($actualStore -ne $storeRoot -and -not $actualStore.StartsWith("$storeRoot\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "pnpm store is outside configured cache: $storePath"
    }
    foreach ($cachePath in @($env:NPM_CONFIG_CACHE, $env:ELECTRON_CACHE, $env:ELECTRON_BUILDER_CACHE, $storeRoot)) {
        New-Item -ItemType Directory -Force -Path $cachePath | Out-Null
    }
    Write-Host "==> pnpm store path: $storePath"
    }
    $encodedSetup = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($setup.ToString()))
    Invoke-CommandWithHardTimeout -Executable "powershell.exe" -Command "-NoProfile -NonInteractive -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand $encodedSetup" -TimeoutMinutes 10
}

function Collect-Artifacts {
    $artifactDir = Join-Path $PWD.Path "artifacts\windows"
    if (-not (Test-Path $artifactDir)) {
        New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
    }

    $exeFiles = @(Get-ChildItem -Path "release\*.exe" -File -ErrorAction SilentlyContinue)
    if ($exeFiles.Count -eq 0) {
        throw "No release exe files found under release\*.exe"
    }
    foreach ($file in $exeFiles) {
        if ($file.Length -le 0) {
            throw "Release artifact is empty: $($file.FullName)"
        }
    }

    $commitHash = & git rev-parse HEAD
    $infoFile = Join-Path $artifactDir "BUILD_INFO.txt"
    "Commit: $commitHash" | Out-File -FilePath $infoFile -Encoding utf8
    "BuildDate: $((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"))" | Add-Content -Path $infoFile
    "" | Add-Content -Path $infoFile

    foreach ($file in $exeFiles) {
        Write-Host "==> Copying artifact: $($file.Name) ($($file.Length) bytes)"
        Copy-Item -Path $file.FullName -Destination (Join-Path $artifactDir $file.Name) -Force
        $sha = (Get-FileHash -Path $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$sha  $($file.Name)" | Add-Content -Path $infoFile
        Write-Host "    SHA256: $sha"
    }

    Write-Host "==> Artifact collection completed successfully."
}

function Invoke-BuildAction {
    param([string]$Stage)
    if (-not (Test-Path -LiteralPath $budgetFile)) { throw "Missing build budget; run begin-budget first." }
    $budget = Get-Content -LiteralPath $budgetFile -Raw | ConvertFrom-Json
    $script:deadlineUtc = [DateTime]::Parse($budget.deadlineUtc).ToUniversalTime()
    $remainingMs = ($script:deadlineUtc - [DateTime]::UtcNow).TotalMilliseconds
    if ($remainingMs -le 0 -or $remainingMs -gt (55 * 60 * 1000)) { throw "Invalid or exhausted absolute job budget." }
    $actionTimer = [Diagnostics.Stopwatch]::StartNew()
    try {
        # Keep predist:win and every dist:win command in their original order.
        # npm run preserves nested/pre/post lifecycle hooks (including prebuild).
        switch ($Stage) {
            "install-toolchain" { Install-NodeToolchain }
            "dependencies" { Invoke-CommandWithHardTimeout -Command "npm install" -TimeoutMinutes 10 }
            "runtime" {
                # Reserve five minutes for export/workspace transfer, within the job deadline.
                $script:deadlineUtc = $script:deadlineUtc.AddMinutes(-5)
                Invoke-CommandWithHardTimeout -Command "npm run openclaw:runtime:win-x64" -TimeoutMinutes 50
            }
            "export-runtime" { Invoke-CommandWithHardTimeout -Command "node .circleci\runtime-workspace.cjs export" -TimeoutMinutes 5 }
            "import-runtime" {
                Invoke-CommandWithHardTimeout -Command "node .circleci\runtime-workspace.cjs import" -TimeoutMinutes 5
                Invoke-CommandWithHardTimeout -Command "node scripts\sync-openclaw-runtime-current.cjs win-x64" -TimeoutMinutes 2
            }
            "verify-installer" { Invoke-CommandWithHardTimeout -Command "npm run verify:installer-patches" -TimeoutMinutes 2 }
            "python" { Invoke-CommandWithHardTimeout -Command "npm run setup:python-runtime" -TimeoutMinutes 5 }
            "build-client" { Invoke-CommandWithHardTimeout -Command "npm run build" -TimeoutMinutes 10 }
            "compile-electron" { Invoke-CommandWithHardTimeout -Command "npm run compile:electron" -TimeoutMinutes 5 }
            "skills" { Invoke-CommandWithHardTimeout -Command "npm run build:skills" -TimeoutMinutes 5 }
            "package" {
                Invoke-CommandWithHardTimeout -Command "node_modules\.bin\electron-builder.cmd --win --x64 --config scripts/electron-builder-config.cjs --publish never" -TimeoutMinutes 15
            }
            "artifacts" {
                $helper = $PSCommandPath.Replace("'", "''")
                $collect = "& '$helper' collect-artifacts-internal"
                $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($collect))
                Invoke-CommandWithHardTimeout -Executable "powershell.exe" -Command "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded" -TimeoutMinutes 5
            }
            default { throw "Unknown action: $Stage" }
        }
    } finally {
        $actionTimer.Stop()
        $remainingMs = [Math]::Max(0, ([DateTime]::Parse($budget.deadlineUtc).ToUniversalTime() - [DateTime]::UtcNow).TotalMilliseconds)
        Write-Host "==> $([DateTime]::UtcNow.ToString('o')) Action $Stage duration=$($actionTimer.Elapsed.TotalSeconds.ToString('F3'))s; remaining job budget=$([Math]::Round($remainingMs / 60000, 3))m"
    }
}

switch ($Action) {
    "begin-budget" { Initialize-BuildBudget }
    "collect-artifacts-internal" { Collect-Artifacts }
    "all" {
        Initialize-BuildBudget
        foreach ($stage in @("install-toolchain", "dependencies", "runtime", "verify-installer", "python", "build-client", "compile-electron", "skills", "package", "artifacts")) {
            Invoke-BuildAction $stage
        }
    }
    "build" {
        foreach ($stage in @("dependencies", "runtime", "verify-installer", "python", "build-client", "compile-electron", "skills", "package")) {
            Invoke-BuildAction $stage
        }
    }
    default { Invoke-BuildAction $Action }
}
