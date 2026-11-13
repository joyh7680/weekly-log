$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 24 이상을 설치해 주세요.' }
$taskNodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($taskNodeMajor -lt 24) { throw 'Node.js 24 이상이 필요합니다.' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw '패키지 설치에 실패했습니다.' }
}
npm run build
if ($LASTEXITCODE -ne 0) { throw '앱 빌드에 실패했습니다.' }
Write-Host '위클리로그: http://localhost:4310'
npm start
