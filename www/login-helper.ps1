param([string]$Callback)
$ErrorActionPreference = 'Stop'

# 不向任何服务器发送授权码：只将本次回调复制到剪贴板。
if ($Callback) {
    $uri = [Uri]$Callback
    if ($uri.Scheme -ne 'ms-xal-000000004c20a908' -or $uri.Host -ne 'auth' -or
        $uri.Query -notmatch '(^|[?&])code=') {
        throw 'Unexpected Xbox authorization callback.'
    }
    Set-Clipboard -Value $Callback
    Write-Host 'Callback copied. Paste it into your XboxWebRemote page to finish sign-in.'
    Read-Host 'Press Enter to close'
    exit
}

$installDir = Join-Path $env:LOCALAPPDATA 'XboxWebRemote'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$helper = Join-Path $installDir 'login-helper.ps1'
if ($PSCommandPath -ne $helper) { Copy-Item -LiteralPath $PSCommandPath -Destination $helper -Force }
$key = 'HKCU:\Software\Classes\ms-xal-000000004c20a908'
if (Test-Path $key) {
    $answer = Read-Host 'An Xbox login handler already exists. Replace it with the clipboard helper? [y/N]'
    if ($answer -ne 'y') { exit }
}
New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-Item -Path $key -Value 'URL:XboxWebRemote Login'
New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
$powershell = Join-Path $PSHOME 'powershell.exe'
$command = '"{0}" -NoProfile -STA -File "{1}" -Callback "%1"' -f $powershell, $helper
Set-Item -Path "$key\shell\open\command" -Value $command
Write-Host 'Installed. The helper only copies login callbacks to your clipboard.'
