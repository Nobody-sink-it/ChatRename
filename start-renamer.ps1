$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { Write-Host '未找到 Node.js，请先安装 Node.js 22 或更高版本。'; exit 1 }
if (-not $env:RENAMER_CODEX_EXE) {
    $renamerCodex = Get-Command codex.exe -ErrorAction SilentlyContinue
    if ($renamerCodex) { $env:RENAMER_CODEX_EXE = $renamerCodex.Source }
}
if (-not $env:RENAMER_CODEX_EXE) {
    $codexBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $codexBin) {
        $candidate = Get-ChildItem -LiteralPath $codexBin -Directory | Sort-Object LastWriteTime -Descending | ForEach-Object {
            $file = Join-Path $_.FullName 'codex.exe'
            if (Test-Path -LiteralPath $file -PathType Leaf) { $file }
        } | Select-Object -First 1
        if ($candidate) { $env:RENAMER_CODEX_EXE = $candidate }
    }
}
if (-not $env:RENAMER_CODEX_EXE -or -not (Test-Path -LiteralPath $env:RENAMER_CODEX_EXE -PathType Leaf)) {
    Write-Host '未找到 codex.exe。请先安装并登录 Codex CLI，或设置 RENAMER_CODEX_EXE。'
    exit 1
}
Write-Host "使用 Codex：$env:RENAMER_CODEX_EXE"
Write-Host '正在启动本机命名服务。启动后请打开显示的本机地址，复制配对码到插件。'
& $nodeCommand.Source (Join-Path $PSScriptRoot 'local-codex\server.mjs')
exit $LASTEXITCODE
