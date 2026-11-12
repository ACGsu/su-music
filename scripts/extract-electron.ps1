param([string]$Archive,[string]$Destination,[string]$Workspace)
$ErrorActionPreference='Stop'
$workspacePath=[IO.Path]::GetFullPath($Workspace).TrimEnd('\')+'\'
$archivePath=[IO.Path]::GetFullPath($Archive)
$destinationPath=[IO.Path]::GetFullPath($Destination)
if(-not $archivePath.StartsWith($workspacePath,[StringComparison]::OrdinalIgnoreCase) -or -not $destinationPath.StartsWith($workspacePath,[StringComparison]::OrdinalIgnoreCase)){throw 'EXTRACTION_OUTSIDE_WORKSPACE'}
Expand-Archive -LiteralPath $archivePath -DestinationPath $destinationPath -Force
