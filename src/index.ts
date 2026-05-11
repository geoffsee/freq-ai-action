import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as tc from "@actions/tool-cache";

const REPO = "geoffsee/caretta";
const BINARY = "caretta";

const TASKS_REQUIRING_ARG = new Set([
  "fix-conflicts",
  "fix-pr",
  "issue",
  "loop",
  "tracker-matrix",
]);

type Platform = {
  os: "linux" | "macos";
  arch: "x86_64" | "aarch64";
};

type VersionManifest = {
  resolvedVersion: string;
  cachedAt: string;
  platform: string;
};

function detectPlatform(): Platform {
  const rawOs = process.platform;
  const rawArch = process.arch;

  let osName: Platform["os"];
  if (rawOs === "linux") osName = "linux";
  else if (rawOs === "darwin") osName = "macos";
  else throw new Error(`Unsupported OS: ${rawOs} (caretta supports linux and macOS runners)`);

  let archName: Platform["arch"];
  if (rawArch === "x64") archName = "x86_64";
  else if (rawArch === "arm64") archName = "aarch64";
  else throw new Error(`Unsupported architecture: ${rawArch}`);

  return { os: osName, arch: archName };
}

async function resolveVersion(requested: string, token: string): Promise<string> {
  if (requested && requested !== "latest") {
    return requested.startsWith("v") ? requested : `v${requested.replace(/^v/, "")}`;
  }
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "caretta-action",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to resolve latest caretta release: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { tag_name?: string };
  if (!body.tag_name) throw new Error("Latest release response missing tag_name");
  return body.tag_name;
}

function getManifestPath(platform: Platform): string {
  const tempDir = process.env.RUNNER_TEMP || os.tmpdir();
  return path.join(tempDir, `caretta-manifest-${platform.arch}-${platform.os}.json`);
}

async function loadVersionManifest(platform: Platform): Promise<VersionManifest | null> {
  const manifestPath = getManifestPath(platform);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(manifestPath, "utf-8");
    return JSON.parse(content) as VersionManifest;
  } catch {
    return null;
  }
}

async function saveVersionManifest(manifest: VersionManifest, platform: Platform): Promise<void> {
  const manifestPath = getManifestPath(platform);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

async function checkNewReleaseAvailable(
  currentVersion: string,
  token: string,
): Promise<string | null> {
  try {
    const latestVersion = await resolveVersion("latest", token);
    if (latestVersion !== currentVersion) {
      core.info(`New release available: ${latestVersion} (current: ${currentVersion})`);
      return latestVersion;
    }
    return null;
  } catch (err) {
    core.warning(`Failed to check for new releases: ${err}`);
    return null;
  }
}

async function installCaretta(
  versionInput: string,
  platform: Platform,
  token: string,
): Promise<{ binaryPath: string; version: string }> {
  const isLatestRequested = !versionInput || versionInput === "latest";

  // Load cached manifest to check if we have a resolved version
  const manifest = await loadVersionManifest(platform);

  let version: string;

  if (isLatestRequested && manifest) {
    // Check if a new release is available
    const newVersion = await checkNewReleaseAvailable(manifest.resolvedVersion, token);
    if (newVersion) {
      version = newVersion;
      core.info(`Upgrading from ${manifest.resolvedVersion} to ${version}`);
    } else {
      version = manifest.resolvedVersion;
      core.info(`Using cached latest version: ${version}`);
    }
  } else if (!isLatestRequested) {
    // Specific version requested - normalize it
    version = versionInput.startsWith("v")
      ? versionInput
      : `v${versionInput.replace(/^v/, "")}`;
  } else {
    // First run or no manifest - resolve the version
    version = await resolveVersion(versionInput, token);
  }

  // Check tool-cache for this specific version
  const cached = tc.find(BINARY, version, platform.arch);
  if (cached) {
    core.info(`Using cached caretta ${version} from tool-cache`);
    const binaryPath = path.join(cached, BINARY);

    // Update manifest for latest requests
    if (isLatestRequested) {
      await saveVersionManifest(
        {
          resolvedVersion: version,
          cachedAt: new Date().toISOString(),
          platform: `${platform.arch}-${platform.os}`,
        },
        platform,
      );
    }

    return { binaryPath, version };
  }

  // Download the artifact
  const artifact = `${BINARY}-${platform.arch}-${platform.os}.tar.gz`;
  const url = `https://github.com/${REPO}/releases/download/${version}/${artifact}`;
  core.info(`Downloading ${url}`);

  const tarball = await tc.downloadTool(url);
  const extracted = await tc.extractTar(tarball);
  const cachedDir = await tc.cacheDir(extracted, BINARY, version, platform.arch);
  const binaryPath = path.join(cachedDir, BINARY);

  await exec.exec("chmod", ["+x", binaryPath]);
  core.addPath(cachedDir);

  // Save manifest for latest tracking
  if (isLatestRequested) {
    await saveVersionManifest(
      {
        resolvedVersion: version,
        cachedAt: new Date().toISOString(),
        platform: `${platform.arch}-${platform.os}`,
      },
      platform,
    );
  }

  return { binaryPath, version };
}

const LINUX_RUNTIME_DEPS = [
  "libxdo3",
  "libwebkit2gtk-4.1-0",
  "libgtk-3-0",
  "libayatana-appindicator3-1",
  "libsoup-3.0-0",
];

async function installLinuxRuntimeDeps(platform: Platform): Promise<void> {
  if (platform.os !== "linux") return;
  core.info(`Installing caretta runtime deps: ${LINUX_RUNTIME_DEPS.join(", ")}`);
  await exec.exec("sudo", ["apt-get", "update", "-qq"], { silent: true });
  await exec.exec(
    "sudo",
    ["apt-get", "install", "-y", "--no-install-recommends", ...LINUX_RUNTIME_DEPS],
    { silent: true },
  );
}

// caretta's CLI reads DEV_BOT_PRIVATE_KEY as a *path* to a PEM. Workflows
// commonly only have the base64-encoded PEM as a secret, so decode it to a
// temp file and point DEV_BOT_PRIVATE_KEY at it.
function materializeBotPrivateKey(env: Record<string, string>): void {
  const b64 = env.DEV_BOT_PRIVATE_KEY_B64;
  if (!b64 || env.DEV_BOT_PRIVATE_KEY) return;
  const pem = Buffer.from(b64, "base64").toString("utf8");
  core.setSecret(pem);
  const dir = env.RUNNER_TEMP && env.RUNNER_TEMP.length > 0 ? env.RUNNER_TEMP : os.tmpdir();
  const pemPath = path.join(dir, "dev-bot.pem");
  fs.writeFileSync(pemPath, pem, { mode: 0o600 });
  env.DEV_BOT_PRIVATE_KEY = pemPath;
  core.info(`Decoded DEV_BOT_PRIVATE_KEY_B64 to ${pemPath}`);
}

async function configureGitIdentity(): Promise<void> {
  await exec.exec("git", ["config", "--global", "user.name", "github-actions[bot]"]);
  await exec.exec("git", [
    "config",
    "--global",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
}

function buildArgs(
  task: string,
  taskArgs: string,
  agent: string,
  auto: boolean,
  dryRun: boolean,
  preset: string,
): string[] {
  const args: string[] = ["--agent", agent];
  if (auto) args.push("--auto");
  if (dryRun) args.push("--dry-run");
  if (preset) args.push("--preset", preset);
  args.push(task);

  const trimmed = taskArgs.trim();
  if (trimmed) {
    args.push(...trimmed.split(/\s+/));
  } else if (TASKS_REQUIRING_ARG.has(task)) {
    throw new Error(`Task '${task}' requires the 'args' input (e.g. a PR or issue number).`);
  }
  return args;
}

async function run(): Promise<void> {
  try {
    const task = core.getInput("task", { required: true }).trim();
    if (!task) throw new Error("Input 'task' cannot be empty.");

    const taskArgs = core.getInput("args") ?? "";
    const agent = core.getInput("agent") || "claude";
    const versionInput = core.getInput("version") || "latest";
    const auto = core.getBooleanInput("auto");
    const dryRun = core.getBooleanInput("dry-run");
    const preset = (core.getInput("preset") ?? "").trim();
    const workingDirectory = core.getInput("working-directory");
    const configureGit = core.getBooleanInput("configure-git");
    const ghToken = core.getInput("github-token");

    const platform = detectPlatform();
    core.info(`Runner platform: ${platform.arch}-${platform.os} (node ${process.version})`);

    const { binaryPath, version } = await installCaretta(versionInput, platform, ghToken);
    core.info(`Resolved caretta ${version}`);
    core.setOutput("installed-version", version);
    core.info(`Installed caretta at ${binaryPath}`);

    await installLinuxRuntimeDeps(platform);

    if (configureGit) {
      await configureGitIdentity();
    }

    const args = buildArgs(task, taskArgs, agent, auto, dryRun, preset);

    const env: { [key: string]: string } = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    if (ghToken) env.GH_TOKEN = ghToken;
    if (!env.RUST_LOG) env.RUST_LOG = "info";
    materializeBotPrivateKey(env);

    const cwd = workingDirectory && workingDirectory.length > 0 ? workingDirectory : process.env.GITHUB_WORKSPACE || process.cwd();

    core.info(`Running: ${binaryPath} ${args.join(" ")} (cwd=${cwd})`);

    let exitCode: number;
    if (task === "tracker-matrix") {
      const result = await exec.getExecOutput(binaryPath, args, {
        cwd,
        env,
        silent: false,
        ignoreReturnCode: true,
      });
      exitCode = result.exitCode;
      const trimmed = result.stdout.trim();
      core.setOutput("issues-json", trimmed);
      let issueCount = "0";
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          issueCount = String(parsed.length);
        }
      } catch {
        // malformed stdout — leave count at 0
      }
      core.setOutput("issue-count", issueCount);
    } else {
      exitCode = await exec.exec(binaryPath, args, {
        cwd,
        env,
        ignoreReturnCode: true,
      });
      core.setOutput("issues-json", "");
      core.setOutput("issue-count", "0");
    }

    core.setOutput("exit-code", String(exitCode));
    if (exitCode !== 0) {
      core.setFailed(`caretta ${task} exited with code ${exitCode}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(message);
  }
}

void run();
