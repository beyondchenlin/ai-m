import { execFileSync } from "node:child_process";
import fs from "node:fs";

export type BackupFileSecurityPolicy = {
  verifyParent: (directory: string) => void;
  protect: (filename: string) => void;
  verify: (filename: string) => void;
};

type SecurityDependencies = {
  platform?: NodeJS.Platform;
  run?: typeof execFileSync;
  chmod?: (filename: string, mode: number) => void;
  stat?: (filename: string) => { mode: number };
};

const WINDOWS_SECURITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$payload = ($input | Out-String | ConvertFrom-Json)
$filename = [string]$payload.path
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($payload.action -eq 'protect') {
  $security = New-Object System.Security.AccessControl.FileSecurity
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$security.AddAccessRule($rule)
  Set-Acl -LiteralPath $filename -AclObject $security
} elseif ($payload.action -ne 'verify' -and $payload.action -ne 'verifyParent') {
  throw 'Unknown file-security action'
}
$actual = Get-Acl -LiteralPath $filename
$owner = $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$validRule = (
  $rules.Count -eq 1 -and
  $rules[0].IdentityReference.Value -eq $sid.Value -and
  -not $rules[0].IsInherited -and
  $rules[0].AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
  (($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)
)
$ok = $actual.AreAccessRulesProtected -and $owner -eq $sid.Value -and $validRule
if (-not $ok) { throw 'Backup file DACL is not current-SID-only FullControl with inheritance removed' }
[pscustomobject]@{ ok=$true; sid=$sid.Value; owner=$owner; ruleCount=$rules.Count } | ConvertTo-Json -Compress
`;

function runWindowsSecurity(
  action: "protect" | "verify" | "verifyParent",
  filename: string,
  run: typeof execFileSync,
): void {
  const output = run("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SECURITY_SCRIPT,
  ], {
    input: JSON.stringify({ action, path: filename }),
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  let attestation: unknown;
  try { attestation = JSON.parse(String(output).trim()); }
  catch (error) { throw new Error("Windows backup ACL tool returned invalid output", { cause: error }); }
  const result = attestation as { ok?: unknown; sid?: unknown; owner?: unknown; ruleCount?: unknown };
  const sid = String(result?.sid ?? "");
  if (typeof attestation !== "object" || attestation === null
    || result.ok !== true || !/^S-\d(?:-\d+)+$/.test(sid)
    || result.owner !== sid || result.ruleCount !== 1) {
    throw new Error("Windows backup ACL verification did not return a valid attestation");
  }
}

export function createBackupFileSecurityPolicy(
  dependencies: SecurityDependencies = {},
): BackupFileSecurityPolicy {
  const platform = dependencies.platform ?? process.platform;
  if (platform === "win32") {
    const run = dependencies.run ?? execFileSync;
    return {
      verifyParent: (directory) => runWindowsSecurity("verifyParent", directory, run),
      protect: (filename) => runWindowsSecurity("protect", filename, run),
      verify: (filename) => runWindowsSecurity("verify", filename, run),
    };
  }
  const chmod = dependencies.chmod ?? fs.chmodSync;
  const stat = dependencies.stat ?? fs.statSync;
  const verify = (filename: string) => {
    const mode = stat(filename).mode & 0o777;
    if (mode !== 0o600) throw new Error(`Backup file mode must be 0600, received 0${mode.toString(8)}`);
  };
  return {
    verifyParent: (directory) => {
      const info = fs.lstatSync(directory);
      const getuid = process.getuid;
      if (!info.isDirectory() || typeof getuid !== "function" || info.uid !== getuid() || (info.mode & 0o022) !== 0) {
        throw new Error("Backup parent directory must be owned by the current uid and not group/other writable");
      }
    },
    protect: (filename) => { chmod(filename, 0o600); verify(filename); },
    verify,
  };
}
