import * as path from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as tc from "@actions/tool-cache";

const REPO = "geoffsee/freq-ai";
const BINARY = "freq-ai";

const TASKS_REQUIRING_ARG = new Set(["fix-pr", "issue", "loop", "tracker-matrix"]);

type Platform = {
  os: "linux" | "macos";
  arch: "x86_64" | "aarch64";
};

function detectPlatform(): Platform {
  const rawOs = process.platform;
  const rawArch = process.arch;

  let osName: Platform["os"];
  if (rawOs === "linux") osName = "linux";
  else if (rawOs === "darwin") osName = "macos";
  else throw new Error(`Unsupported OS: ${rawOs} (freq-ai supports linux and macOS runners)`);

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
    "User-Agent": "freq-ai-action",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
  if (!res.ok) {
    throw new Error(`Failed to resolve latest freq-ai release: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { tag_name?: string };
  if (!body.tag_name) throw new Error("Latest release response missing tag_name");
  return body.tag_name;
}

async function installFreqAi(version: string, platform: Platform): Promise<string> {
  const cached = tc.find(BINARY, version, platform.arch);
  if (cached) {
    core.info(`Using cached freq-ai ${version} from ${cached}`);
    return path.join(cached, BINARY);
  }

  const artifact = `${BINARY}-${platform.arch}-${platform.os}.tar.gz`;
  const url = `https://github.com/${REPO}/releases/download/${version}/${artifact}`;
  core.info(`Downloading ${url}`);

  const tarball = await tc.downloadTool(url);
  const extracted = await tc.extractTar(tarball);
  const cachedDir = await tc.cacheDir(extracted, BINARY, version, platform.arch);
  const binaryPath = path.join(cachedDir, BINARY);

  await exec.exec("chmod", ["+x", binaryPath]);
  core.addPath(cachedDir);
  return binaryPath;
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
  core.info(`Installing freq-ai runtime deps: ${LINUX_RUNTIME_DEPS.join(", ")}`);
  await exec.exec("sudo", ["apt-get", "update", "-qq"], { silent: true });
  await exec.exec(
    "sudo",
    ["apt-get", "install", "-y", "--no-install-recommends", ...LINUX_RUNTIME_DEPS],
    { silent: true },
  );
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

    const version = await resolveVersion(versionInput, ghToken);
    core.info(`Resolving freq-ai ${version}`);
    core.setOutput("installed-version", version);

    const binaryPath = await installFreqAi(version, platform);
    core.info(`Installed freq-ai at ${binaryPath}`);

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
      core.setFailed(`freq-ai ${task} exited with code ${exitCode}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(message);
  }
}

void run();
