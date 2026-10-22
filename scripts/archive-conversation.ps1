param(
    [string]$Date = (Get-Date).ToString('yyyy-MM-dd'),
    # 留空则从 config.json 的 chatLog.dir 取（出厂默认在那里定义，本脚本不重复写死）
    [string]$OutDir = '',
    # 留空则从 config.json 的 allow.private / allow.groups 取。
    # **不要在这里写死真实 QQ 号/群号** —— 本文件会进公开仓库，privacy-scan 会拦。
    [string[]]$PrivateIds = @(),
    [string[]]$GroupIds = @(),
    [int]$KeepTopPrivate = 5,
    [int]$KeepTopGroup = 3,
    [int]$MaxLineChars = 110,
    # 额外的「整条丢弃」正则：命中的那条消息直接不算（用于过滤 agent 报错刷屏之类）。
    [string]$SystemNoise = '',
    [switch]$NoFetch
)
$ErrorActionPreference = 'Stop'

# ────────────────────────────────────────────────────────────────
# 每天把 QQ 私聊/群聊整理成「精简版」对话记录，写进 D:\日记\对话记录\YYYY-MM-DD.md
#
# 设计目标：留「当天发生了什么、谁说了什么要紧的」，不要逐条抄。
#   1) 从 OneBot 拉最近历史（拉不到就直接失败，不写半截文件）
#   2) 丢掉纯图片/纯表情（同一人连发 >=3 张才记一笔）、空 @、单字应答、纯寒暄
#   3) 同一个人连着说的几句并成一条；10 分钟一段
#   4) 段内按信息量打分，只留最要紧的几行（大肥鱼说的优先、长的优先、带关键词的优先）
#   5) 顶部「一、当天要紧的事」留一个占位，由写日记的人补
# ────────────────────────────────────────────────────────────────

$Root = Split-Path -Parent $PSScriptRoot
$CfgPath = Join-Path $Root 'config.json'
if (-not (Test-Path $CfgPath)) { throw "找不到配置文件：$CfgPath" }
$cfg = Get-Content $CfgPath -Raw -Encoding utf8 | ConvertFrom-Json

$httpUrl = if ($cfg.snowluma.httpUrl) { $cfg.snowluma.httpUrl } else { 'http://127.0.0.1:3000' }
$token   = $cfg.snowluma.accessToken
if (-not $token) { throw 'config.json 里没有 snowluma.accessToken' }
$headers = @{ authorization = "Bearer $token"; 'content-type' = 'application/json' }

# 参数没传就从 config.json 推：真值只存在 config.json（已 gitignore），脚本本身不含真实号码。
if (-not $OutDir) {
    $OutDir = if ($cfg.chatLog.dir) { $cfg.chatLog.dir } else { Join-Path (Join-Path 'D:\' '日记') '对话记录' }
}
if (-not $PrivateIds -or $PrivateIds.Count -eq 0) {
    $PrivateIds = @($cfg.allow.private | ForEach-Object { [string]$_ })
}
if (-not $GroupIds -or $GroupIds.Count -eq 0) {
    $GroupIds = @($cfg.allow.groups | ForEach-Object { [string]$_ })
}

$CacheDir = Join-Path $Root 'state\agents\.tmp\conv-rec'
New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

function Invoke-OneBot([string]$Action, [hashtable]$Params) {
    $body = $Params | ConvertTo-Json -Depth 8 -Compress
    $r = Invoke-RestMethod -Uri "$httpUrl/$Action" -Method Post -Headers $headers -Body $body -TimeoutSec 40
    if ($r.status -ne 'ok' -or $r.retcode -ne 0) { throw "OneBot $Action 失败：status=$($r.status) retcode=$($r.retcode)" }
    return $r.data
}

# ── 1. 拉历史 ───────────────────────────────────────────────
$private = @()
$group   = @()

# 机器人自己的 QQ 号：从 OneBot 现取（不写死在脚本里，因为本文件会进公开仓库）。
$selfId = ''
try {
    $login = Invoke-OneBot 'get_login_info' @{}
    if ($login -and $login.user_id) { $selfId = [string]$login.user_id }
} catch { Write-Warning "get_login_info 失败，稍后无法把「大肥鱼」从历史里识别出来：$($_.Exception.Message)" }

if (-not $NoFetch) {
    $script:gotPrivate = $false
    $script:gotGroup = $false
    foreach ($uid in $PrivateIds) {
        try {
            $d = Invoke-OneBot 'get_friend_msg_history' @{ user_id = [long]$uid; count = 150 }
            $msgs = @($d.messages)
            $private += $msgs
            if ($msgs.Count -gt 0) { $script:gotPrivate = $true }
            Write-Output "拉取私聊 $uid：$($msgs.Count) 条"
        } catch { Write-Warning "私聊 $uid 拉取失败：$($_.Exception.Message)" }
    }
    foreach ($gid in $GroupIds) {
        try {
            $d = Invoke-OneBot 'get_group_msg_history' @{ group_id = [long]$gid; count = 200 }
            $msgs = @($d.messages)
            $group += $msgs
            if ($msgs.Count -gt 0) { $script:gotGroup = $true }
            Write-Output "拉取群 $gid：$($msgs.Count) 条"
        } catch { Write-Warning "群 $gid 拉取失败：$($_.Exception.Message)" }
    }
    if ($private.Count -gt 0) { $private | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $CacheDir 'private.json') -Encoding utf8 }
    if ($group.Count -gt 0)   { $group   | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $CacheDir 'group.json')   -Encoding utf8 }
} else {
    $pf = Join-Path $CacheDir 'private.json'
    $gf = Join-Path $CacheDir 'group.json'
    if (Test-Path $pf) { $private = @(Get-Content $pf -Raw -Encoding utf8 | ConvertFrom-Json) }
    if (Test-Path $gf) { $group   = @(Get-Content $gf -Raw -Encoding utf8 | ConvertFrom-Json) }
    Write-Output "跳过拉取，用缓存：private=$($private.Count) group=$($group.Count)"
}

# ── 2. 时间窗 ───────────────────────────────────────────────
$dt = [datetime]::ParseExact($Date, 'yyyy-MM-dd', $null)
$dayStart = [DateTimeOffset]::new($dt.Year, $dt.Month, $dt.Day, 0, 0, 0, [TimeSpan]::FromHours(8)).ToUnixTimeSeconds()
$dayEnd   = $dayStart + 86400
function Fmt([long]$t) { [DateTimeOffset]::FromUnixTimeSeconds($t).ToLocalTime().ToString('HH:mm') }

# ── 3. 名字表 ───────────────────────────────────────────────
$names = @{}
foreach ($m in $group) {
    if ($m.sender -and $m.sender.user_id) {
        $n = if ($m.sender.card) { $m.sender.card } else { $m.sender.nickname }
        if ($n) { $names[[string]$m.sender.user_id] = $n }
    }
}
foreach ($m in $private) {
    if ($m.sender -and $m.sender.user_id -and -not $names.ContainsKey([string]$m.sender.user_id)) {
        if ($m.sender.nickname) { $names[[string]$m.sender.user_id] = $m.sender.nickname }
    }
}
$SELF = $selfId
if ($SELF) { $names[$SELF] = '大肥鱼' }
# 主人那栏显示成昵称，而不是把真实 QQ 号写死在脚本里。
foreach ($uid in $PrivateIds) { if (-not $names.ContainsKey([string]$uid)) { $names[[string]$uid] = '主人' } }
$SELF_NAME = '大肥鱼'

$noise = @('？','?','！','!','嗯','哦','呃','啊','好','行','草','6','...','。。。','在','到','可以','哈哈','笑死','确实','是的','对','没事','睡了','好的')
$kw = '动态|说说|空间|日记|记忆|锚点|表情包|接口|工具|手机|群|配置|bug|token|AI|鱼|收到|发|记|写|改|修|装|试|看|查|学|玩|断|挂|重启|报错|失败|成功|为什么|怎么|能不能|要不要|诚|怪|奖|评|图'
# 系统刷屏：整条丢弃（这些不是人话，留着只占地方）
# 默认这份是「出厂值」；-SystemNoise 传了就用传进来的（追加在默认值后面）。
$systemNoise = 'agent 处理出错|workbuddy upstream|⏹️|已停止|fetch failed|\[object Object\]|request_id'
if ($SystemNoise) { $systemNoise = "(?:$systemNoise)|(?:$SystemNoise)" }

function RenderSegs($m) {
    $sb = New-Object System.Text.StringBuilder
    $media = 0
    foreach ($seg in $m.message) {
        switch ($seg.type) {
            'text'   { [void]$sb.Append($seg.data.text) }
            'at'     { $q = [string]$seg.data.qq
                       $nm = if ($names.ContainsKey($q)) { $names[$q] } else { $q }
                       [void]$sb.Append("@$nm ") }
            'image'  { $media++ }
            'face'   { $media++ }
            'record' { [void]$sb.Append('[语音]') }
            'video'  { [void]$sb.Append('[视频]') }
            'file'   { [void]$sb.Append('[文件]') }
            default  { }
        }
    }
    $t = $sb.ToString().Trim()
    if ($media -gt 0 -and -not $t) { $t = "[图片×$media]" }
    return $t
}

function Who($m) {
    $id = [string]$m.user_id
    if ($names.ContainsKey($id)) { return $names[$id] }
    return $id
}

# → 干净的 [{t, who, text}]，噪音已滤
function Normalize($arr) {
    $items = New-Object System.Collections.ArrayList
    $sorted = @($arr | Sort-Object time)
    $runMedia = 0; $runWho = $null; $runT = 0
    foreach ($m in $sorted) {
        $who = Who $m
        $txt = RenderSegs $m
        $mm = [regex]::Match($txt, '^\[图片×(\d+)\]$')
        if ($mm.Success) {
            $n = [int]$mm.Groups[1].Value
            if ($runWho -eq $who) { $runMedia += $n }
            else { $runWho = $who; $runMedia = $n; $runT = $m.time }
            continue
        }
        if ($runMedia -ge 3) { [void]$items.Add([pscustomobject]@{ t = $runT; who = $runWho; text = "[连发图片 $runMedia 张]" }) }
        $runMedia = 0; $runWho = $null
        if (-not $txt) { continue }
        if ($txt -match $systemNoise) { continue }
        if ($noise -contains $txt) { continue }
        if ($txt -match '^(@\S+\s*)+$') { continue }
        [void]$items.Add([pscustomobject]@{ t = $m.time; who = $who; text = $txt })
    }
    if ($runMedia -ge 3) { [void]$items.Add([pscustomobject]@{ t = $runT; who = $runWho; text = "[连发图片 $runMedia 张]" }) }
    return $items
}

function Score($who, $text) {
    $s = 0
    if ($who -eq $SELF_NAME) { $s += 2 }
    if ($text.Length -ge 15) { $s += 1 }
    if ($text.Length -ge 40) { $s += 1 }
    if ($text -match $kw) { $s += 2 }
    if ($text.Length -le 6 -and $text -notmatch $kw) { $s -= 2 }
    if ($text -match '^(上号|打不打|来打|打nm|等|下了|睡了|在吗|人呢)') { $s -= 2 }
    return $s
}

# 长句按「；」切开，只留信息量最高的前两小节 —— 否则一个人连说十句会糊成一大段谁也读不下去
function TightenText([string]$text, [int]$maxChars) {
    if ($text.Length -le $maxChars) { return $text }
    $parts = @($text -split '；' | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
    if ($parts.Count -le 1) { return ($text.Substring(0, $maxChars) + '…') }
    $ranked = @($parts | ForEach-Object { [pscustomobject]@{ p = $_; s = (Score 'x' $_) } } |
                Sort-Object -Property s -Descending | Select-Object -First 2)
    $picked = @($parts | Where-Object { $ranked.p -contains $_ })
    $joined = $picked -join '；'
    if ($joined.Length -gt $maxChars) { $joined = $joined.Substring(0, $maxChars) + '…' }
    return $joined
}

function RenderBlock($items, [int]$keepTop) {
    if ($items.Count -eq 0) { return '' }
    $sb = New-Object System.Text.StringBuilder
    $bucket = $null; $cur = $null
    $blocks = New-Object System.Collections.ArrayList
    foreach ($it in $items) {
        $d = [DateTimeOffset]::FromUnixTimeSeconds($it.t).ToLocalTime()
        $b = [int][math]::Floor(($d.Hour * 60 + $d.Minute) / 10)
        if ($b -ne $bucket) {
            if ($cur) { [void]$blocks.Add($cur) }
            $bucket = $b
            $cur = [pscustomobject]@{ start = $it.t; end = $it.t; lines = (New-Object System.Collections.ArrayList) }
        }
        $cur.end = $it.t
        if ($cur.lines.Count -gt 0 -and $cur.lines[$cur.lines.Count - 1].who -eq $it.who) {
            $last = $cur.lines[$cur.lines.Count - 1]
            $last.text = "$($last.text)；$($it.text)"
        } else {
            [void]$cur.lines.Add([pscustomobject]@{ who = $it.who; text = $it.text })
        }
    }
    if ($cur) { [void]$blocks.Add($cur) }

    foreach ($blk in $blocks) {
        $scored = @($blk.lines | ForEach-Object {
            $t = TightenText $_.text $MaxLineChars
            [pscustomobject]@{ who = $_.who; text = $t; score = (Score $_.who $_.text) }
        })
        $keep = @($scored | Where-Object { $_.score -ge 1 } | Sort-Object -Property score -Descending | Select-Object -First $keepTop)
        if ($keep.Count -eq 0) { $keep = @($scored | Sort-Object -Property score -Descending | Select-Object -First 1) }
        if ($keep.Count -eq 0) { continue }
        $ordered = @($scored | Where-Object { $keep -contains $_ })
        $merged = New-Object System.Collections.ArrayList
        foreach ($l in $ordered) {
            if ($merged.Count -gt 0 -and $merged[$merged.Count - 1].who -eq $l.who) {
                $merged[$merged.Count - 1].text = "$($merged[$merged.Count - 1].text)；$($l.text)"
            } else {
                [void]$merged.Add([pscustomobject]@{ who = $l.who; text = $l.text })
            }
        }
        $range = if ((Fmt $blk.start) -eq (Fmt $blk.end)) { Fmt $blk.start } else { "$(Fmt $blk.start)–$(Fmt $blk.end)" }
        [void]$sb.AppendLine("### $range")
        [void]$sb.AppendLine()
        foreach ($l in $merged) { [void]$sb.AppendLine("- $($l.who)：$($l.text)") }
        [void]$sb.AppendLine()
    }
    return $sb.ToString()
}

# ── 4. 渲染 ─────────────────────────────────────────────────
$pToday = @($private | Where-Object { $_.time -ge $dayStart -and $_.time -lt $dayEnd })
$gToday = @($group   | Where-Object { $_.time -ge $dayStart -and $_.time -lt $dayEnd })

if ($pToday.Count -eq 0 -and $gToday.Count -eq 0) {
    $existing = Join-Path $OutDir "$Date.md"
    if (Test-Path $existing) {
        Write-Output "今天（$Date）没有可归档的消息，已有记录保持不变。"
    } else {
        Write-Output "今天（$Date）没有可归档的消息，跳过，不留空文件。"
    }
    Write-Output ('RESULT ' + ([ordered]@{ ok = $false; date = $Date; reason = 'no-messages'; out = $existing } | ConvertTo-Json -Compress))
    return
}

$pItems = Normalize $pToday
$gItems = Normalize $gToday

# ── 摘要保护 ────────────────────────────────────────────────
# 每天可能被跑好几次（手动一次、21:50 定时一次、事后补一次）。
# 如果当天文件已经有了，并且「一、当天要紧的事」已经被填过（不是占位符），
# 就把那段原封不动抄过来，只重写下面的私聊/群聊两节 —— 手改过的摘要不会被冲掉。
$out = Join-Path $OutDir "$Date.md"
$existedBefore = Test-Path $out
$keepSummary = $null
if ($existedBefore) {
    $old = Get-Content $out -Raw -Encoding utf8
    if ($old -match '(?ms)^##\s*一、当天要紧的事\s*$(.*?)(?=^##\s|\z)') {
        $oldBody = $Matches[1].Trim()
        if ($oldBody -and $oldBody -notmatch '由写入方补充') { $keepSummary = $oldBody }
    }
}

# ── 覆盖范围保护 ────────────────────────────────────────────
# OneBot 只能读「最近 N 条」，不能往回翻页。所以：
#   · 拉取直接失败（OneBot 没开 / 网络不通）→ 一个字节都不写，免得把好文件换成空文件；
#   · 拉取成功但这一天的消息已经完全滚出窗口 → 同样跳过，不覆盖已有的记录；
#   · 拉取到的是「半天」（比如中午才开机，只捞到上午之后）→ 照写，但在头部标出覆盖的时间段，
#     让人一眼看出这份记录不完整。
if (-not $NoFetch -and -not $script:gotPrivate -and -not $script:gotGroup) {
    Write-Output "OneBot 没拉到任何历史（未启动或连不上），不写文件。"
    Write-Output ('RESULT ' + ([ordered]@{ ok = $false; date = $Date; reason = 'no-history'; out = (Join-Path $OutDir "$Date.md") } | ConvertTo-Json -Compress))
    return
}

# 实际覆盖的时间段（用来标注「可能不全」）
$allTimes = @(@($pToday) + @($gToday) | ForEach-Object { $_.time } | Sort-Object)
$coverText = ''
if ($allTimes.Count -gt 0) {
    $fmt = { param($t) [DateTimeOffset]::FromUnixTimeSeconds($t).ToLocalTime().ToString('HH:mm') }
    $coverText = (& $fmt $allTimes[0]) + '–' + (& $fmt $allTimes[-1])
}

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("# $Date 对话记录")
[void]$sb.AppendLine()
[void]$sb.AppendLine('> 精简版：只留过程和决定，语气词、刷图、纯寒暄已删。要点见下方「一」。')
[void]$sb.AppendLine("> 原始：私聊 $($pToday.Count) 条 / 群 $($gToday.Count) 条。")
if ($coverText) {
    # 起得晚：早上那半截已经不在 OneBot 的窗口里了
    $startHour = [DateTimeOffset]::FromUnixTimeSeconds($allTimes[0]).ToLocalTime().Hour
    if ($startHour -gt 2) { [void]$sb.AppendLine("> 覆盖：$coverText（之前的部分已不在 OneBot 窗口里）。") }
}
[void]$sb.AppendLine()
[void]$sb.AppendLine('## 一、当天要紧的事')
[void]$sb.AppendLine()
if ($keepSummary) {
    [void]$sb.AppendLine($keepSummary)
} else {
    [void]$sb.AppendLine('- （由写入方补充）')
}
[void]$sb.AppendLine()
if ($pToday.Count -gt 0) {
    [void]$sb.AppendLine('## 二、私聊「123」')
    [void]$sb.AppendLine()
    [void]$sb.Append((RenderBlock $pItems $KeepTopPrivate))
}
if ($gToday.Count -gt 0) {
    [void]$sb.AppendLine('## 三、群「洲暗」')
    [void]$sb.AppendLine()
    [void]$sb.Append((RenderBlock $gItems $KeepTopGroup))
}

$text = $sb.ToString()
[System.IO.File]::WriteAllText($out, $text, (New-Object System.Text.UTF8Encoding($false)))
$mode = if ($keepSummary) { '保留原摘要' } else { '摘要待补' }
Write-Output "WROTE $out ($($text.Length) chars, $mode)"

# ── 机器可读结果 ────────────────────────────────────────────
# 这个脚本会被 DSH 会话的工具描述里调用，agent 要判断「这天是不是补跑的」。
# 所以除了一句人话，再给一行 JSON：existedBefore=false 就说明是这次才生成/补出来的。
$result = [ordered]@{
    ok            = $true
    date          = $Date
    out           = $out
    chars         = $text.Length
    existedBefore = [bool]$existedBefore
    private       = $pToday.Count
    group         = $gToday.Count
    cover         = $coverText
    summary       = $(if ($keepSummary) { 'kept' } else { 'pending' })
}
Write-Output ('RESULT ' + ($result | ConvertTo-Json -Compress))
