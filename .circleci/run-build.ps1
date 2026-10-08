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

function Invoke-CommandWithHardTimeout {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [Parameter(Mandatory = $true)]
        [int]$TimeoutMinutes,
        [string]$WorkingDirectory = $PWD.Path,
        [string]$Executable = "cmd.exe"
    )

    Write-Host "==> Starting command (Timeout: ${TimeoutMinutes}m): $Command"
    $timeoutMs = $TimeoutMinutes * 60 * 1000

    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = $Executable
    $pinfo.Arguments = if ($Executable -eq "cmd.exe") { "/c $Command" } else { $Command }
    $pinfo.WorkingDirectory = $WorkingDirectory
    $pinfo.UseShellExecute = $false

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $pinfo

    $started = $false
    $timedOut = $false
    try {
        $started = $proc.Start()
        if (-not $started) {
            throw "Failed to start process for command: $Command"
        }
        $exited = $proc.WaitForExit($timeoutMs)
        if (-not $exited) {
            $timedOut = $true
            throw "Command execution timed out after ${TimeoutMinutes} minutes: $Command"
        }
        if ($proc.ExitCode -ne 0) {
            throw "Command failed with exit code $($proc.ExitCode): $Command"
        }
    } finally {
        try {
            if ($timedOut -and $started -and -not $proc.HasExited -and $proc.Id -gt 0 -and $proc.Id -ne $PID) {
                Write-Warning "Timeout: terminating owned process tree $($proc.Id)."
                & taskkill.exe /PID $proc.Id /T /F
                if ($LASTEXITCODE -ne 0) {
                    Write-Warning "taskkill failed with exit code $LASTEXITCODE."
                }
            }
        } finally {
            $proc.Dispose()
        }
    }
    Write-Host "==> Finished command successfully: $Command"
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
    & node.exe -v
    if ($LASTEXITCODE -ne 0) { throw "Node version check failed." }
    $npmVer = (& npm.cmd -v).Trim()
    if ($LASTEXITCODE -ne 0) { throw "npm version check failed." }
    Write-Host "==> Bundled npm version: $npmVer"

    # Ensure npm >= 11.17 < 12
    $semverMatch = [regex]::Match($npmVer, "^(\d+)\.(\d+)")
    $needNpmUpgrade = $true
    if ($semverMatch.Success) {
        $major = [int]$semverMatch.Groups[1].Value
        $minor = [int]$semverMatch.Groups[2].Value
        if ($major -eq 11 -and $minor -ge 17) {
            $needNpmUpgrade = $false
        }
    }

    if ($needNpmUpgrade) {
        Write-Host "==> Updating npm to 11.17.0..."
        & npm.cmd install --global --prefix $nodeDir npm@11.17.0
        if ($LASTEXITCODE -ne 0) { throw "npm installation failed." }
        & npm.cmd -v
        if ($LASTEXITCODE -ne 0) { throw "npm version check failed." }
    }

    # Match OpenClaw's packageManager pin; npm runs the native binary installer.
    Write-Host "==> Installing pnpm 12.1.0..."
    & npm.cmd install --global --prefix $nodeDir pnpm@12.1.0
    if ($LASTEXITCODE -ne 0) { throw "pnpm installation failed." }
    $pnpmVersion = (& pnpm.cmd --version).Trim()
    if ($LASTEXITCODE -ne 0) { throw "pnpm version check failed." }
    if ($pnpmVersion -ne "12.1.0") { throw "Expected pnpm 12.1.0, got $pnpmVersion." }
    Write-Host "==> pnpm version: $pnpmVersion"
    }
    $encodedSetup = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($setup.ToString()))
    Invoke-CommandWithHardTimeout -Executable "powershell.exe" -Command "-NoProfile -NonInteractive -OutputFormat Text -ExecutionPolicy Bypass -EncodedCommand $encodedSetup" -TimeoutMinutes 10
}

function Build-LobsterAI {
    Write-Host "==> Installing dependencies (npm install)..."
    Invoke-CommandWithHardTimeout -Command "npm install" -TimeoutMinutes 10

    # Artifact-only CI builds must not inherit certificate signing credentials.
    Get-ChildItem Env: | Where-Object { $_.Name -like "CSC_*" -or $_.Name -like "WIN_CSC_*" } | ForEach-Object {
        Remove-Item -LiteralPath "Env:$($_.Name)"
    }
    $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
    $env:LOBSTERAI_UNSIGNED_WINDOWS = "1"

    Write-Host "==> Building Windows package (dist:win -- --publish never with signing disabled)..."
    Invoke-CommandWithHardTimeout -Command "npm run dist:win -- --publish never" -TimeoutMinutes 50
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

switch ($Action) {
    "install-toolchain" { Install-NodeToolchain }
    "build"             { Build-LobsterAI }
    "artifacts"         { Collect-Artifacts }
    "all" {
        Install-NodeToolchain
        Build-LobsterAI
        Collect-Artifacts
    }
    default {
        throw "Unknown action: $Action"
    }
}
