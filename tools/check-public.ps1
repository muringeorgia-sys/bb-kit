# Проверка перед публикацией: рабочие и личные данные + ключи.
# Печатает файл, строку и тип находки, без значения. Код выхода 1 — есть находки.
# Запуск: powershell -ExecutionPolicy Bypass -File tools\check-public.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path $PSScriptRoot -Parent

$rules = [ordered]@{
  # Рабочие и личные данные
  'work'            = '(?i)mashina|redash|jira|confluence|mbank|мбанк|house\.kg|lalafo|clickhouse|mad\.kg|сэвэн|express leasing|риом|бишкек|дилер|госномер'
  'project-paths'   = '(?i)Skills-Results|nmt-base|NMT-Дополнения|_ВИКИ|05_logs|03_scripts|OneDrive|_СЛУЖЕБНОЕ'
  'personal'        = '(?i)ueabq|isichenko|\boleg\b|олег'
  'tracker-keys'    = '\b(PRODUCT|MASH|MOD|DESIGN)-\d+\b'
  'telegram-chat'   = '-100\d{10}'
  'google-doc'      = 'docs\.google\.com/(spreadsheets|document|presentation)/d/'
  'atlassian'       = '(?i)[a-z0-9-]+\.atlassian\.net'
  'email'           = '(?i)\b[a-z0-9._%+-]+@(?!users\.noreply\.github\.com|example\.com|localhost)[a-z0-9.-]+\.[a-z]{2,}\b'
  # Ключи
  'private-key'     = '-----BEGIN [A-Z ]*PRIVATE KEY'
  'openai-anthropic'= '\bsk-(ant-)?[A-Za-z0-9_-]{20,}'
  'github-token'    = '\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}'
  'slack'           = '\bxox[abposr]-[A-Za-z0-9-]{10,}'
  'aws'             = '\bAKIA[0-9A-Z]{16}\b'
  'google-key'      = '\bAIza[0-9A-Za-z_-]{35}'
  'telegram-bot'    = '\b\d{8,10}:AA[A-Za-z0-9_-]{30,}'
  'jwt'             = '\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.'
  'assign'          = '(?i)(api[_-]?key|apikey|token|secret|passw(or)?d|authorization|bearer)["''\s:=]{1,6}(Key |Bearer |token )?["'']?[A-Za-z0-9_\-\.]{20,}'
}
$skipDirs = @('\.git\', '\node_modules\', '\dist\')
$skipFiles = @('package-lock.json', 'check-public.ps1')
$skipExt = @('.png','.jpg','.jpeg','.gif','.webp','.ico','.pdf','.zip','.woff','.woff2','.ttf')

$allowFile = Join-Path $root 'tools\public-allowlist.txt'
$allow = @()
if (Test-Path $allowFile) { $allow = Get-Content $allowFile -Encoding UTF8 | Where-Object { $_ -and -not $_.StartsWith('#') } | ForEach-Object { $_.Trim() } }

$hits = New-Object System.Collections.Generic.List[string]
$n = 0
Get-ChildItem -LiteralPath $root -Recurse -File -Force | Where-Object {
  $p = $_.FullName
  -not ($skipDirs | Where-Object { $p.Contains($_) }) -and $skipFiles -notcontains $_.Name -and $skipExt -notcontains $_.Extension.ToLower()
} | ForEach-Object {
  $n++
  $rel = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
  $i = 0
  foreach ($line in [IO.File]::ReadAllLines($_.FullName)) {
    $i++
    foreach ($r in $rules.GetEnumerator()) {
      if ($line -match $r.Value -and $allow -notcontains "${rel}:$($r.Key)") { $hits.Add("${rel}:$i [$($r.Key)]") }
    }
  }
}
Write-Host "Проверено файлов: $n"
if ($hits.Count) {
  Write-Host "Находки ($($hits.Count)) — публиковать нельзя:" -ForegroundColor Red
  $hits | ForEach-Object { Write-Host "  $_" }
  Write-Host "Уберите данные или, если это не они, добавьте 'путь:тип' в tools/public-allowlist.txt."
  exit 1
}
Write-Host 'Рабочих данных и ключей не найдено.' -ForegroundColor Green
exit 0
