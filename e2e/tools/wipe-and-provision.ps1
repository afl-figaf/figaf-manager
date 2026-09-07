# wipe-and-provision.ps1 - virgin e2e run for the Figaf Platform (D1 seed).
#
# Transparency contract (same as the release build script):
#   - Every cf command is printed with ">>" before it runs.
#   - Ends with "<MODE> PASSED" (exit 0) or "FAILED: <reason>" (exit 1).
#   - Guardrail: refuses to run unless the cf target is EXACTLY
#     org "Figaf ApS_figafpartner-1" / space "figaf-platform".
#
# Modes:
#   -Mode status              print apps + service instances in the space
#   -Mode wipe                DRY RUN: print what would be deleted
#   -Mode wipe -Force         delete ALL apps, service keys, service
#                             instances, and orphaned routes in the space
#   -Mode wipe -Force -Keep figaf-faid-db
#                             same, but keep the named service instances
#                             (PostgreSQL alone costs ~15 min to delete and
#                             re-create; xsuaa and credstore take seconds).
#                             Apps are always deleted, so bindings to a kept
#                             instance are removed with them.
#   -Mode provision           create the base services of a virgin FAID Apps install:
#                               figaf-faid-db         postgresql-db / free
#                               figaf-faid-xsuaa      xsuaa / application  (xs-security.json)
#                               figaf-faid-credstore  credstore / free     (basic auth on instance)
#                             and wait until every create succeeded.
#                             NOTE: it-rt/api is NOT created here - the FAID
#                             Apps do not bind it (the Archiving Setup app
#                             needs only db + xsuaa + credstore). The Figaf
#                             tool's own it-rt service is a separate concern
#                             (Connect-to-Integration-Suite flow), and its
#                             broker was returning 500s on 2026-09-02.
#
# The manager itself is NOT deployed by this script - that follows the
# runbook (build + cf push): docs/d1/MANUAL-RUNBOOK.md in the figaf-platform repo.

param(
    [Parameter(Mandatory = $true)][ValidateSet('status', 'wipe', 'provision')][string]$Mode,
    [switch]$Force,
    [string[]]$Keep = @(),
    [string]$XsSecurity = ""
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not (Get-Command cf -ErrorAction SilentlyContinue)) {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (Get-Command cf -ErrorAction SilentlyContinue)) { Write-Host 'FAILED: cf CLI not found even after PATH refresh.'; exit 1 }
}

$AllowedOrg = 'Figaf ApS_figafpartner-1'
$AllowedSpace = 'figaf-platform'

function Fail {
    param([string]$Reason)
    Write-Host "FAILED: $Reason"
    exit 1
}

function Invoke-Cf {
    param([string[]]$CfArgs)
    Write-Host (">> cf " + ($CfArgs -join ' '))
    & cf @CfArgs
    if ($LASTEXITCODE -ne 0) { Fail ("command failed: cf " + ($CfArgs -join ' ')) }
}

# -- guardrail: exact org + space -----------------------------------------------
Write-Host '>> cf target'
$target = & cf target
$target | ForEach-Object { Write-Host $_ }
if ($LASTEXITCODE -ne 0) { Fail 'not logged in (cf login).' }
$org = (($target | Where-Object { $_ -match '^org:\s+\S' } | Select-Object -First 1) -replace '^org:\s+', '').Trim()
$space = (($target | Where-Object { $_ -match '^space:\s+\S' } | Select-Object -First 1) -replace '^space:\s+', '').Trim()
if ($org -ne $AllowedOrg -or $space -ne $AllowedSpace) {
    Fail "this script only runs against '$AllowedOrg' / '$AllowedSpace' (current target: '$org' / '$space')"
}
Write-Host '>> cf oauth-token   (token validity check; token is not printed)'
$null = & cf oauth-token
if ($LASTEXITCODE -ne 0) { Fail 'login token expired. Run cf login again.' }

# -- space inventory via the CF API (scoped by space guid) ----------------------
$spaceGuid = (& cf space $AllowedSpace --guid).Trim()
if ($LASTEXITCODE -ne 0 -or -not $spaceGuid) { Fail 'could not resolve the space guid' }

function Get-SpaceApps {
    $json = (& cf curl "/v3/apps?space_guids=$spaceGuid&per_page=200") -join "`n"
    if ($LASTEXITCODE -ne 0) { Fail 'cf curl /v3/apps failed' }
    return (($json | ConvertFrom-Json).resources | ForEach-Object { $_.name })
}

function Get-SpaceServices {
    $json = (& cf curl "/v3/service_instances?space_guids=$spaceGuid&per_page=200") -join "`n"
    if ($LASTEXITCODE -ne 0) { Fail 'cf curl /v3/service_instances failed' }
    return (($json | ConvertFrom-Json).resources | ForEach-Object { $_.name })
}

function Get-ServiceKeys {
    param([string]$InstanceName)
    $json = (& cf curl "/v3/service_credential_bindings?type=key&service_instance_names=$InstanceName&per_page=200") -join "`n"
    if ($LASTEXITCODE -ne 0) { return @() }
    return (($json | ConvertFrom-Json).resources | ForEach-Object { $_.name })
}

$apps = @(Get-SpaceApps)
$services = @(Get-SpaceServices)

Write-Host ''
Write-Host ("Apps in ${AllowedSpace}:     " + $(if ($apps.Count) { $apps -join ', ' } else { '(none)' }))
Write-Host ("Services in ${AllowedSpace}: " + $(if ($services.Count) { $services -join ', ' } else { '(none)' }))
Write-Host ''

if ($Mode -eq 'status') {
    Write-Host 'STATUS PASSED'
    exit 0
}

if ($Mode -eq 'wipe') {
    $kept = @($services | Where-Object { $Keep -contains $_ })
    $servicesToDelete = @($services | Where-Object { $Keep -notcontains $_ })
    $unknownKeep = @($Keep | Where-Object { $services -notcontains $_ })
    if ($unknownKeep.Count) { Write-Host ("NOTE: -Keep names not present in the space: " + ($unknownKeep -join ', ')) }
    if ($kept.Count) { Write-Host ("Keeping service instances: " + ($kept -join ', ')) }

    if (-not $Force) {
        Write-Host 'DRY RUN (no -Force): the commands below WOULD run:'
        foreach ($a in $apps) { Write-Host "   cf delete $a -f -r" }
        foreach ($s in $servicesToDelete) {
            foreach ($k in @(Get-ServiceKeys $s | Select-Object -Unique)) { Write-Host "   cf delete-service-key $s $k -f" }
            Write-Host "   cf delete-service $s -f"
        }
        Write-Host '   cf delete-orphaned-routes -f'
        Write-Host 'WIPE PASSED (dry run only - nothing deleted)'
        exit 0
    }

    foreach ($a in $apps) { Invoke-Cf @('delete', $a, '-f', '-r') }
    foreach ($s in $servicesToDelete) {
        # Key names can repeat (duplicate bindings) - dedupe, and do not fail
        # the run on a key that is already gone; delete-service below will
        # surface any real blocker.
        foreach ($k in @(Get-ServiceKeys $s | Select-Object -Unique)) {
            Write-Host ">> cf delete-service-key $s $k -f"
            & cf delete-service-key $s $k -f
            if ($LASTEXITCODE -ne 0) { Write-Host '   (key delete failed - continuing)' }
        }
        Invoke-Cf @('delete-service', $s, '-f')
    }

    # Service deletion is asynchronous - wait until only the kept ones remain.
    $deadline = (Get-Date).AddMinutes(9)
    while ($true) {
        $left = @(Get-SpaceServices | Where-Object { $Keep -notcontains $_ })
        if ($left.Count -eq 0) { break }
        if ((Get-Date) -gt $deadline) {
            Fail ("timed out waiting for service deletion; still present: " + ($left -join ', ') + ". Re-run '-Mode status' later.")
        }
        Write-Host ("   waiting for deletion of: " + ($left -join ', '))
        Start-Sleep -Seconds 10
    }

    Invoke-Cf @('delete-orphaned-routes', '-f')
    if ($kept.Count) { Write-Host ("WIPE PASSED: apps deleted; kept service instances: " + ($kept -join ', ')) }
    else { Write-Host 'WIPE PASSED: the space is empty.' }
    exit 0
}

if ($Mode -eq 'provision') {
    if ($apps.Count) {
        Fail 'the space still has apps - run -Mode wipe -Force first (or clean up by hand).'
    }
    # Re-running provision is fine as long as only the base services are present
    # (a partial or retried provision). Any OTHER leftover service means the wipe
    # was incomplete - stop rather than build on a dirty space.
    $baseServices = @('figaf-faid-db', 'figaf-faid-xsuaa', 'figaf-faid-credstore')
    $unexpected = @($services | Where-Object { $baseServices -notcontains $_ })
    if ($unexpected.Count) {
        Fail ("unexpected leftover services: " + ($unexpected -join ', ') + " - run -Mode wipe -Force first.")
    }
    # xs-security.json is landscape-independent (decision 0008): its redirect
    # URI carries __CF_APPS_DOMAIN__. Fill it with this landscape's shared cfapps
    # domain before create-service - the App Manager does exactly the same.
    # Default: the release bundled into the manager (built by figaf-platform
    # release\build-artifacts.ps1). Override with -XsSecurity <path>.
    if (-not $XsSecurity) { $XsSecurity = Join-Path $PSScriptRoot '..\..\apps\figaf-manager\platform-artifacts\xs-security.json' }
    $xsSecurityTemplate = $XsSecurity
    if (-not (Test-Path $xsSecurityTemplate)) { Fail "$xsSecurityTemplate not found - build the release first (figaf-platform release\build-artifacts.ps1) or pass -XsSecurity" }
    $domainLine = (& cf domains | Where-Object { $_ -match '^\s*cfapps\.' } | Select-Object -First 1)
    if (-not $domainLine) { Fail 'no cfapps.* shared domain found (cf domains) - cannot fill the XSUAA redirect URI.' }
    $appsDomain = ([string]$domainLine).Trim() -split '\s+' | Select-Object -First 1
    Write-Host ">> XSUAA redirect URI domain: $appsDomain"
    $xsSecurity = Join-Path $env:TEMP 'figaf-faid-xs-security.json'
    (Get-Content $xsSecurityTemplate -Raw).Replace('__CF_APPS_DOMAIN__', $appsDomain) | Set-Content -Encoding Ascii $xsSecurity
    # Basic authentication MUST be configured on the credstore INSTANCE: the
    # broker rejects it on binding level (learned 2026-08-31).
    $credstoreConfig = Join-Path $env:TEMP 'figaf-faid-credstore-config.json'
    '{"authentication":{"type":"basic"}}' | Set-Content -Encoding Ascii $credstoreConfig

    # Idempotent: skip a service that already exists (e.g. after a partial run).
    $existing = @(Get-SpaceServices)
    if ($existing -notcontains 'figaf-faid-db') { Invoke-Cf @('create-service', 'postgresql-db', 'free', 'figaf-faid-db') }
    if ($existing -notcontains 'figaf-faid-xsuaa') { Invoke-Cf @('create-service', 'xsuaa', 'application', 'figaf-faid-xsuaa', '-c', $xsSecurity) }
    if ($existing -notcontains 'figaf-faid-credstore') { Invoke-Cf @('create-service', 'credstore', 'free', 'figaf-faid-credstore', '-c', $credstoreConfig) }

    $wanted = @('figaf-faid-db', 'figaf-faid-xsuaa', 'figaf-faid-credstore')
    $deadline = (Get-Date).AddMinutes(9)
    while ($true) {
        $pending = @()
        foreach ($name in $wanted) {
            $status = (& cf service $name | Where-Object { $_ -match 'status:' } | Select-Object -First 1)
            if ($status -match 'failed') { Fail "service $name reports: $status" }
            if (-not ($status -match 'create succeeded')) { $pending += "$name ($(($status -replace '^\s*status:\s*','').Trim()))" }
        }
        if ($pending.Count -eq 0) { break }
        if ((Get-Date) -gt $deadline) {
            Fail ("timed out waiting for: " + ($pending -join ', ') + ". PostgreSQL can take a while - re-run '-Mode status' or this mode again later.")
        }
        Write-Host ("   waiting for: " + ($pending -join ', '))
        Start-Sleep -Seconds 10
    }
    Write-Host 'PROVISION PASSED: base services ready (db, xsuaa, credstore).'
    exit 0
}
