[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param([ValidateRange(1, 65534)][int]$Port = 5173)

$ErrorActionPreference = 'Stop'
$serverPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../server.mjs'))
$argument = '(?i)(?:^|\s)"' + [regex]::Escape($serverPath) + '"(?:\s|$)'
if ($serverPath -notmatch '\s') { $argument += '|(?i)(?:^|\s)' + [regex]::Escape($serverPath) + '(?:\s|$)' }
$ownerIds = @(& netstat.exe -ano -p tcp | ForEach-Object {
    if ($_ -match ('^\s*TCP\s+\S+:' + $Port + '\s+\S+\s+LISTENING\s+(\d+)\s*$')) { [int]$Matches[1] }
} | Sort-Object -Unique)
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect TCP listeners; nothing was stopped.' }
if (!$ownerIds.Count) { Write-Host "[Writide] No server is listening on port $Port."; exit 0 }

foreach ($ownerId in $ownerIds) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
    if (!$process -or $process.Name -ne 'node.exe' -or $process.CommandLine -notmatch $argument) {
        throw "Port $Port belongs to PID $ownerId, but its command does not identify this checkout. Refusing to stop it. For a legacy launcher, use its original terminal or verify the process manually."
    }
    Write-Host "[Writide] Port $Port, PID $ownerId, $serverPath"
    Write-Host '[Writide] Save or export unsaved documents in ALL tabs first. This closes the backend, not the browser.'
    if ($PSCmdlet.ShouldProcess("PID $ownerId on port $Port", 'Stop this Writide server (unsaved edits are not saved automatically)')) {
        # Check process identity again after the user confirmation, before stopping.
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerId"
        if (!$current -or $current.CreationDate -ne $process.CreationDate -or $current.CommandLine -ne $process.CommandLine) {
            throw 'Process identity changed; nothing was stopped.'
        }
        Stop-Process -Id $ownerId -ErrorAction Stop
        Write-Host '[Writide] Server stopped. The browser tab can now be closed.'
    }
}
