param(
  [string]$ProjectPath = '',
  [string]$Model = 'gpt-5.5',
  [int]$SessionCreatedTimeoutSeconds = 10,
  [int]$ReconnectTimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'

$workspace = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime-paths.ps1')

$node = Resolve-MobileCodexNodePath
$repo = if ($env:MOBILE_CODEX_UPSTREAM_DIR) {
  $env:MOBILE_CODEX_UPSTREAM_DIR
} else {
  Join-Path $workspace 'vendor\claudecodeui-1.25.2'
}

if (-not (Test-Path $repo)) {
  throw "Upstream checkout not found: $repo"
}

if (-not $ProjectPath) {
  $ProjectPath = $workspace
}

$stdoutLog = Join-Path $workspace 'tmp\logs\mobile-codex-app.stdout.log'
if (-not (Test-Path $stdoutLog)) {
  throw "App stdout log not found: $stdoutLog"
}

$logStream = [System.IO.File]::Open($stdoutLog, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
try {
  $buffer = New-Object byte[] $logStream.Length
  [void]$logStream.Read($buffer, 0, $buffer.Length)
} finally {
  $logStream.Dispose()
}

$logText = -join ($buffer | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ })
$tokenMatches = [regex]::Matches($logText, 'token=([A-Za-z0-9\-_\.]+)')
if ($tokenMatches.Count -eq 0) {
  throw 'No WebSocket token found in app stdout log. Open the app locally and log in once before running this smoke test.'
}

$env:TEST_WS_TOKEN = $tokenMatches[$tokenMatches.Count - 1].Groups[1].Value
$env:TEST_PROJECT_PATH = $ProjectPath
$env:TEST_MODEL = $Model
$env:TEST_SESSION_CREATED_TIMEOUT_MS = ($SessionCreatedTimeoutSeconds * 1000).ToString()
$env:TEST_RECONNECT_TIMEOUT_MS = ($ReconnectTimeoutSeconds * 1000).ToString()

$nodeScript = @'
const WebSocket = require("ws");

const token = process.env.TEST_WS_TOKEN;
const projectPath = process.env.TEST_PROJECT_PATH;
const model = process.env.TEST_MODEL || "gpt-5.5";
const sessionCreatedTimeoutMs = Number(process.env.TEST_SESSION_CREATED_TIMEOUT_MS || "10000");
const reconnectTimeoutMs = Number(process.env.TEST_RECONNECT_TIMEOUT_MS || "20000");
const url = `ws://127.0.0.1:3001/ws?token=${token}`;

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function main() {
  const first = await connect();
  let sessionId = null;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for session-created")), sessionCreatedTimeoutMs);

    first.on("message", raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "session-created") {
        sessionId = msg.sessionId;
        clearTimeout(timeout);
        resolve();
      }
    });

    first.send(JSON.stringify({
      type: "codex-command",
      command: "Use a shell command to list the repository root briefly, then reply with exactly READY.",
      options: {
        cwd: projectPath,
        projectPath,
        model,
        permissionMode: "default"
      }
    }));
  });

  await new Promise(resolve => setTimeout(resolve, 200));
  first.close();

  const second = await connect();
  const seen = [];

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for post-reconnect codex-response; seen=${JSON.stringify(seen)}`));
    }, reconnectTimeoutMs);

    second.on("message", raw => {
      const msg = JSON.parse(raw.toString());
      seen.push(msg.type);

      if (msg.type === "codex-response" && msg.sessionId === sessionId) {
        clearTimeout(timeout);
        resolve({
          sessionId,
          seen,
          ok: true
        });
      }
    });

    second.send(JSON.stringify({
      type: "check-session-status",
      provider: "codex",
      sessionId
    }));
  });

  second.send(JSON.stringify({
    type: "abort-session",
    provider: "codex",
    sessionId
  }));

  setTimeout(() => second.close(), 250);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
'@

Push-Location $repo
try {
  $output = $nodeScript | & $node -
  if ($LASTEXITCODE -ne 0) {
    throw 'Reconnect smoke test failed.'
  }

  $output | Write-Output
} finally {
  Pop-Location
}
