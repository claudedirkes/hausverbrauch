# Leneda-Abruf fuer "Hausverbrauch"
# Holt Strom (15 min), geteilten Strom (Energiegemeinschaft, alle Ebenen) und Gas von Leneda
# und schickt sie an das Apps Script. Das Script schreibt Tageswerte in "Historie" und die
# Viertelstunden in "Leneda 15 min". Laeuft auf dem PC zu Hause, weil Leneda Google-Server sperrt.
# Zugangsdaten werden beim ersten Start abgefragt und in leneda_config.json neben diesem Skript gespeichert.

$ErrorActionPreference = 'Stop'
$LenedaUrl  = 'https://api.leneda.lu/api'
$ObisStrom  = '1-1:1.29.0'
$ObisGeteilt = @('1-65:1.29.1', '1-65:1.29.3', '1-65:1.29.2', '1-65:1.29.4')
$ObisGas    = '7-1:99.23.15'
$TageProAbruf = 7     # Zeitraum je Leneda-Anfrage
$TageProSenden = 28   # Zeitraum je Sendung ans Apps Script

# ---------- Zugangsdaten ----------
$cfgDatei = Join-Path $PSScriptRoot 'leneda_config.json'
if (Test-Path $cfgDatei) {
    $cfg = Get-Content $cfgDatei -Raw | ConvertFrom-Json
} else {
    Write-Host 'Erster Start: Zugangsdaten eingeben (werden in leneda_config.json gespeichert).'
    $cfg = [pscustomobject]@{
        ApiKey    = Read-Host 'Leneda API-Key'
        EnergyId  = Read-Host 'Energy-ID (LUXE-...)'
        PodStrom  = Read-Host 'Zaehlpunkt Strom (LU...)'
        PodGas    = Read-Host 'Zaehlpunkt Gas (leer lassen, wenn keiner)'
        ScriptUrl = 'https://script.google.com/macros/s/AKfycbzhpkMh_SM98CTPeatrLI6F0BhOWDux-SCZd08H_gWgY2oU3HsEe4npLG2Z9fj25vQz/exec'
        WriteKey  = 'GLEICHER_KEY_WIE_IM_APPS_SCRIPT'
    }
    $cfg | ConvertTo-Json | Set-Content $cfgDatei -Encoding UTF8
}
$kopf = @{ 'X-API-KEY' = $cfg.ApiKey; 'X-ENERGY-ID' = $cfg.EnergyId }

# ---------- Zeitraum ----------
$heute = (Get-Date).Date
$e = Read-Host 'Von (JJJJ-MM-TT, Enter = 2023-01-01)'
$von = if ($e) { [datetime]::ParseExact($e, 'yyyy-MM-dd', $null) } else { [datetime]'2023-01-01' }
$e = Read-Host 'Bis einschliesslich (JJJJ-MM-TT, Enter = gestern)'
$bis = if ($e) { [datetime]::ParseExact($e, 'yyyy-MM-dd', $null).AddDays(1) } else { $heute }

# Eine OBIS-Reihe abrufen. Fehler (z. B. keine Energiegemeinschaft auf dieser Ebene) ergeben eine leere Reihe.
function Hole-Reihe($pod, $obis, $a, $b, $pflicht) {
    $url = "$LenedaUrl/metering-points/$pod/time-series?obisCode=$obis" +
           '&startDateTime=' + $a.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') +
           '&endDateTime='   + $b.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    for ($versuch = 1; $versuch -le 2; $versuch++) {
        try {
            $r = Invoke-RestMethod -Uri $url -Headers $kopf
            # Zeitpunkte immer als UTC-Text weitergeben (PowerShell 7 wandelt sie sonst in Datum um)
            $items = @($r.items | ForEach-Object {
                $t = if ($_.startedAt -is [datetime]) { $_.startedAt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } else { [string]$_.startedAt }
                [pscustomobject]@{ startedAt = $t; value = [double]$_.value }
            })
            return [pscustomobject]@{ items = $items; unit = [string]$r.unit; intervall = [string]$r.intervalLength }
        } catch {
            if ($versuch -eq 2) {
                if ($pflicht) { throw "Leneda $obis : $($_.Exception.Message)" }
                return [pscustomobject]@{ items = @(); unit = ''; intervall = '' }
            }
            Start-Sleep -Seconds 3
        }
    }
}

function Sende($paket, $text) {
    $json = $paket | ConvertTo-Json -Depth 6 -Compress
    for ($versuch = 1; $versuch -le 3; $versuch++) {
        try {
            $r = Invoke-RestMethod -Uri $cfg.ScriptUrl -Method Post -ContentType 'application/json; charset=utf-8' `
                                   -Body ([Text.Encoding]::UTF8.GetBytes($json))
            if (-not $r.ok) { throw "Script: $($r.fehler)" }
            Write-Host ("$text -> $($r.tage) Tage, $($r.viertel) Viertelstunden gespeichert") -ForegroundColor Green
            return
        } catch {
            if ($versuch -eq 3) { throw }
            Write-Host "  Senden fehlgeschlagen ($($_.Exception.Message)), neuer Versuch ..." -ForegroundColor Yellow
            Start-Sleep -Seconds 10
        }
    }
}

# ---------- Abruf in Etappen ----------
Write-Host ''
Write-Host ("Abruf {0:dd.MM.yyyy} bis {1:dd.MM.yyyy}" -f $von, $bis.AddDays(-1))
$start = $von
while ($start -lt $bis) {
    $ende = $start.AddDays($TageProSenden); if ($ende -gt $bis) { $ende = $bis }
    $strom = @(); $gas = @(); $geteilt = @{}
    foreach ($o in $ObisGeteilt) { $geteilt[$o] = @() }
    $einheit = @{}
    $a = $start
    while ($a -lt $ende) {
        $b = $a.AddDays($TageProAbruf); if ($b -gt $ende) { $b = $ende }
        Write-Host ("  Leneda {0:dd.MM.yyyy} - {1:dd.MM.yyyy} ..." -f $a, $b.AddDays(-1))
        $r = Hole-Reihe $cfg.PodStrom $ObisStrom $a $b $true
        $strom += $r.items; $einheit['strom'] = $r
        foreach ($o in $ObisGeteilt) {
            $r = Hole-Reihe $cfg.PodStrom $o $a $b $false
            $geteilt[$o] += $r.items; if ($r.unit) { $einheit[$o] = $r }
        }
        if ($cfg.PodGas) {
            $r = Hole-Reihe $cfg.PodGas $ObisGas $a $b $false
            $gas += $r.items; if ($r.unit) { $einheit['gas'] = $r }
        }
        $a = $b
    }
    $reihe = { param($items, $k) [pscustomobject]@{ items = $items; unit = $einheit[$k].unit; intervall = $einheit[$k].intervall } }
    $paket = [ordered]@{
        key     = $cfg.WriteKey
        aktion  = 'leneda'
        strom   = & $reihe $strom 'strom'
        geteilt = @($ObisGeteilt | Where-Object { $geteilt[$_].Count } | ForEach-Object { & $reihe $geteilt[$_] $_ })
    }
    if ($gas.Count) { $paket.gas = & $reihe $gas 'gas' }
    Sende $paket ("{0:dd.MM.yyyy} - {1:dd.MM.yyyy}: {2} Strom-, {3} Gaswerte" -f $start, $ende.AddDays(-1), $strom.Count, $gas.Count)
    $start = $ende
}
Write-Host ''
Write-Host 'Fertig.' -ForegroundColor Green
Read-Host 'Enter zum Beenden'
