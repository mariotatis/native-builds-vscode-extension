import { execFile, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import type {
  BuildCommandArgs,
  BuildModeOption,
  CommandSpec,
  Destination,
  LaunchArgs,
  Platform,
} from "./platform";

const execFileAsync = promisify(execFile);
const EXEC = { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 };

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".gradle",
  ".idea",
  "build",
  "vendor",
  ".build",
]);

export interface GradleApp {
  gradleRoot: string;
  appDir: string;
  modulePath: string;
}

export async function findGradleApp(
  root: string,
  maxDepth = 4
): Promise<GradleApp | undefined> {
  let gradleRoot: string | undefined;
  const buildFiles: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const fileNames = new Set(
      entries.filter((e) => !e.isDirectory()).map((e) => e.name)
    );
    if (!gradleRoot && (fileNames.has("gradlew") || fileNames.has("gradlew.bat"))) {
      gradleRoot = dir;
    }
    for (const buildFile of ["build.gradle.kts", "build.gradle"]) {
      if (fileNames.has(buildFile)) {
        buildFiles.push(path.join(dir, buildFile));
        break;
      }
    }

    if (depth >= maxDepth) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  if (!gradleRoot) {
    return undefined;
  }

  const aliasAccessors = await applicationPluginAliases(gradleRoot);

  const appDirs: string[] = [];
  for (const buildFile of buildFiles) {
    let text: string;
    try {
      text = await fs.promises.readFile(buildFile, "utf8");
    } catch {
      continue;
    }
    if (isApplicationModule(text, aliasAccessors)) {
      appDirs.push(path.dirname(buildFile));
    }
  }
  if (appDirs.length === 0) {
    return undefined;
  }
  appDirs.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  const appDir = appDirs[0];
  return { gradleRoot, appDir, modulePath: gradleModulePath(gradleRoot, appDir) };
}

function isApplicationModule(buildText: string, aliasAccessors: string[]): boolean {
  const aliasRes = aliasAccessors.map(
    (a) => new RegExp(`plugins\\.${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
  );
  for (const line of buildText.split("\n")) {
    const refsApp =
      /com\.android\.application/.test(line) || aliasRes.some((re) => re.test(line));
    if (!refsApp) {
      continue;
    }
    if (/\bapply\s*\(?\s*false\b/.test(line)) {
      continue;
    }
    return true;
  }
  return false;
}

async function applicationPluginAliases(gradleRoot: string): Promise<string[]> {
  const toml = path.join(gradleRoot, "gradle", "libs.versions.toml");
  let text: string;
  try {
    text = await fs.promises.readFile(toml, "utf8");
  } catch {
    return [];
  }
  const accessors: string[] = [];
  const re =
    /^\s*([A-Za-z0-9_-]+)\s*=\s*\{[^}]*\bid\s*=\s*["']com\.android\.application["']/;
  for (const line of text.split("\n")) {
    const m = re.exec(line);
    if (m) {
      accessors.push(m[1].replace(/[-_]/g, "."));
    }
  }
  return accessors;
}

function gradleModulePath(root: string, moduleDir: string): string {
  if (path.resolve(moduleDir) === path.resolve(root)) {
    return ":";
  }
  const rel = path.relative(root, moduleDir);
  return ":" + rel.split(path.sep).join(":");
}

interface AndroidDevice {
  serial: string;
  isEmulator: boolean;
  avdName?: string;
  model?: string;
}

interface ApkInfo {
  file: string;
  applicationId: string;
}

export class AndroidPlatform implements Platform {
  readonly kind = "android" as const;
  readonly schemeNoun = "variant";
  readonly buildModes: BuildModeOption[] = [
    {
      mode: "build",
      icon: "$(tools)",
      label: "Build",
      short: "Build",
      description: "gradle assemble",
    },
    {
      mode: "clean",
      icon: "$(trash)",
      label: "Clean (delete build folder)",
      short: "Clean",
      description: "gradle clean",
    },
  ];
  readonly projectName: string;

  private variantsCache: string[] | undefined;

  constructor(
    private readonly app: GradleApp,
    private readonly output: vscode.OutputChannel
  ) {
    this.projectName = `${path.basename(app.appDir)} (Gradle)`;
  }

  async listSchemes(force: boolean): Promise<string[]> {
    if (!force && this.variantsCache) {
      return this.variantsCache;
    }
    this.variantsCache = await this.loadVariants();
    return this.variantsCache;
  }

  async listDestinations(_includeAll: boolean): Promise<Destination[]> {
    const sdk = this.requireSdk();
    const [avdNames, running] = await Promise.all([
      this.listAvds(sdk).catch(() => [] as string[]),
      this.listDevices(sdk).catch(() => [] as AndroidDevice[]),
    ]);

    const runningByAvd = new Map<string, string>();
    for (const d of running) {
      if (d.isEmulator && d.avdName) {
        runningByAvd.set(d.avdName, d.serial);
      }
    }

    const dests: Destination[] = [];
    for (const name of avdNames) {
      const serial = runningByAvd.get(name);
      dests.push(
        serial
          ? {
              label: name,
              detail: "Emulator · Booted",
              value: `serial=${serial}`,
              group: "emulator",
            }
          : { label: name, detail: "Emulator", value: `avd=${name}`, group: "emulator" }
      );
    }
    for (const d of running) {
      if (d.isEmulator) {
        if (d.avdName && avdNames.includes(d.avdName)) {
          continue;
        }
        dests.push({
          label: d.avdName ?? d.serial,
          detail: "Emulator · Booted",
          value: `serial=${d.serial}`,
          group: "emulator",
        });
      } else {
        dests.push({
          label: d.model ?? d.serial,
          detail: "Connected device",
          value: `serial=${d.serial}`,
          group: "device",
        });
      }
    }

    dests.sort((a, b) => {
      const aLive = a.value.startsWith("serial=") ? 0 : 1;
      const bLive = b.value.startsWith("serial=") ? 0 : 1;
      if (aLive !== bLive) {
        return aLive - bLive;
      }
      return a.label.localeCompare(b.label);
    });
    return dests;
  }

  buildCommand({ scheme, destination, action }: BuildCommandArgs): CommandSpec {
    const sdk = this.requireSdk();
    const assemble = this.task(`assemble${scheme}`);
    let tasks: string[];
    if (action === "clean") {
      tasks = ["clean"];
    } else if (action === "clean build") {
      tasks = ["clean", assemble];
    } else {
      tasks = [assemble];
    }
    const gradleArgs = vscode.workspace
      .getConfiguration("nativeBuilds")
      .get<string[]>("gradleArgs", []);

    return {
      command: this.gradlewPath(),
      args: [...tasks, "--console=plain", ...gradleArgs],
      cwd: this.app.gradleRoot,
      env: this.env(sdk),
      title: `${capitalize(action)} ${scheme} · ${destination.label}`,
    };
  }

  parseBuildPhase(line: string): string | undefined {
    const t = line.trim();
    if (!t.startsWith("> Task ")) {
      return undefined;
    }
    const taskPath = t.slice("> Task ".length).split(/\s+/)[0];
    const task = (taskPath.split(":").pop() ?? "").toLowerCase();
    const phases: Array<[RegExp, string]> = [
      [/^clean/, "Cleaning…"],
      [/compile|kotlin|javac/, "Compiling…"],
      [/dex/, "Dexing…"],
      [/resource|^process.*manifest|mergemanifest/, "Processing resources…"],
      [/merge/, "Merging…"],
      [/lint/, "Linting…"],
      [/sign/, "Signing…"],
      [/bundle/, "Bundling…"],
      [/package/, "Packaging…"],
      [/assemble|install/, "Assembling…"],
    ];
    for (const [re, label] of phases) {
      if (re.test(task)) {
        return label;
      }
    }
    return undefined;
  }

  async launch({ scheme, destination, log }: LaunchArgs): Promise<void> {
    const sdk = this.requireSdk();
    const adb = adbPath(sdk);
    const serial = await this.ensureDevice(sdk, destination, log);

    log("▶ Locating APK…");
    const apk = await this.findApk(scheme);
    if (!apk) {
      throw new Error(
        `Could not find a built APK for variant "${scheme}". Build first.`
      );
    }

    log(`▶ Installing ${path.basename(apk.file)} on ${destination.label}…`);
    await execFileAsync(adb, ["-s", serial, "install", "-r", "-t", apk.file], EXEC);

    log(`▶ Launching ${apk.applicationId}…`);
    await execFileAsync(
      adb,
      [
        "-s",
        serial,
        "shell",
        "monkey",
        "-p",
        apk.applicationId,
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
      ],
      EXEC
    );
    log(`▶ Launched ${apk.applicationId} on ${destination.label}`);
  }


  private async loadVariants(): Promise<string[]> {
    const sdk = this.requireSdk();
    if (!resolveJavaHome()) {
      throw new Error(
        "No JDK found. Install a JDK or set nativeBuilds.javaHome / JAVA_HOME " +
          "(Android Studio's bundled JDK at .../Android Studio.app/Contents/jbr/Contents/Home works)."
      );
    }
    const taskArg = this.task("tasks");
    const { stdout } = await execFileAsync(
      this.gradlewPath(),
      [taskArg, "--all", "--console=plain"],
      { cwd: this.app.gradleRoot, env: this.env(sdk), ...EXEC }
    );

    const variants = new Set<string>();
    const re = /^install([A-Z][A-Za-z0-9]*)\b/;
    for (const raw of stdout.split("\n")) {
      const m = re.exec(raw.trim());
      if (!m) {
        continue;
      }
      const v = m[1];
      if (/AndroidTest$/.test(v) || /UnitTest$/.test(v)) {
        continue;
      }
      variants.add(v);
    }
    return [...variants].sort((a, b) => a.localeCompare(b));
  }


  private async listAvds(sdk: string): Promise<string[]> {
    const { stdout } = await execFileAsync(emulatorPath(sdk), ["-list-avds"], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => /^[\w.\-]+$/.test(s));
  }

  private async listDevices(sdk: string): Promise<AndroidDevice[]> {
    const adb = adbPath(sdk);
    const { stdout } = await execFileAsync(adb, ["devices", "-l"], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });

    const devices: AndroidDevice[] = [];
    for (const raw of stdout.split("\n")) {
      const line = raw.trim();
      if (!line || /^List of devices/.test(line)) {
        continue;
      }
      const parts = line.split(/\s+/);
      const serial = parts[0];
      const state = parts[1];
      if (state !== "device") {
        continue;
      }
      const isEmulator = serial.startsWith("emulator-");
      const modelTok = parts.find((p) => p.startsWith("model:"));
      const model = modelTok
        ? modelTok.slice("model:".length).replace(/_/g, " ")
        : undefined;
      let avdName: string | undefined;
      if (isEmulator) {
        avdName = await this.emuAvdName(adb, serial).catch(() => undefined);
      }
      devices.push({ serial, isEmulator, avdName, model });
    }
    return devices;
  }

  private async emuAvdName(adb: string, serial: string): Promise<string | undefined> {
    const { stdout } = await execFileAsync(
      adb,
      ["-s", serial, "emu", "avd", "name"],
      { timeout: 5_000, maxBuffer: 64 * 1024 }
    );
    const first = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)[0];
    return first && first !== "OK" ? first : undefined;
  }


  private async ensureDevice(
    sdk: string,
    destination: Destination,
    log: (m: string) => void
  ): Promise<string> {
    const serialMatch = /^serial=(.+)$/.exec(destination.value);
    if (serialMatch) {
      const serial = serialMatch[1];
      await this.waitForBoot(sdk, serial, log);
      return serial;
    }

    const avdMatch = /^avd=(.+)$/.exec(destination.value);
    if (!avdMatch) {
      throw new Error(`Unsupported Android destination "${destination.value}".`);
    }
    const avd = avdMatch[1];

    const running = await this.listDevices(sdk).catch(() => [] as AndroidDevice[]);
    const existing = running.find((d) => d.isEmulator && d.avdName === avd);
    if (existing) {
      await this.waitForBoot(sdk, existing.serial, log);
      return existing.serial;
    }

    log(`▶ Booting emulator ${avd}…`);
    const before = new Set(running.map((d) => d.serial));
    const emu = spawn(emulatorPath(sdk), ["-avd", avd], {
      detached: true,
      stdio: "ignore",
      env: this.env(sdk),
    });
    emu.unref();

    const serial = await this.waitForNewEmulator(sdk, before, avd);
    await this.waitForBoot(sdk, serial, log);
    return serial;
  }

  private async waitForNewEmulator(
    sdk: string,
    before: Set<string>,
    avd: string
  ): Promise<string> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const devices = await this.listDevices(sdk).catch(() => [] as AndroidDevice[]);
      const match =
        devices.find((d) => d.isEmulator && d.avdName === avd) ??
        devices.find((d) => d.isEmulator && !before.has(d.serial));
      if (match) {
        return match.serial;
      }
      await sleep(1000);
    }
    throw new Error(`Emulator ${avd} did not come online within the timeout.`);
  }

  private async waitForBoot(
    sdk: string,
    serial: string,
    log: (m: string) => void
  ): Promise<void> {
    const adb = adbPath(sdk);
    await execFileAsync(adb, ["-s", serial, "wait-for-device"], {
      timeout: 120_000,
    }).catch(() => undefined);

    const deadline = Date.now() + 120_000;
    let logged = false;
    while (Date.now() < deadline) {
      const booted = await execFileAsync(
        adb,
        ["-s", serial, "shell", "getprop", "sys.boot_completed"],
        { timeout: 10_000, maxBuffer: 64 * 1024 }
      )
        .then((r) => r.stdout.trim())
        .catch(() => "");
      if (booted === "1") {
        return;
      }
      if (!logged) {
        log("▶ Waiting for the emulator to finish booting…");
        logged = true;
      }
      await sleep(1500);
    }
    throw new Error(`Device ${serial} did not finish booting within the timeout.`);
  }

  private async findApk(variant: string): Promise<ApkInfo | undefined> {
    const apkRoot = path.join(this.app.appDir, "build", "outputs", "apk");
    const metas = await globFiles(apkRoot, "output-metadata.json");
    const want = lowerFirst(variant);

    const candidates: ApkInfo[] = [];
    for (const meta of metas) {
      try {
        const json = JSON.parse(await fs.promises.readFile(meta, "utf8"));
        const appId: string | undefined = json.applicationId;
        const element = Array.isArray(json.elements) ? json.elements[0] : undefined;
        const outFile: string | undefined = element?.outputFile;
        if (!appId || !outFile) {
          continue;
        }
        const file = path.join(path.dirname(meta), outFile);
        if (!fs.existsSync(file)) {
          continue;
        }
        const variantName: string | undefined = json.variantName;
        const info = { file, applicationId: appId };
        if (variantName && lowerFirst(String(variantName)) === want) {
          return info;
        }
        candidates.push(info);
      } catch {
      }
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }


  private task(suffix: string): string {
    return this.app.modulePath === ":" ? suffix : `${this.app.modulePath}:${suffix}`;
  }

  private gradlewPath(): string {
    const name = process.platform === "win32" ? "gradlew.bat" : "gradlew";
    return path.join(this.app.gradleRoot, name);
  }

  private env(sdk: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
    };
    const javaHome = resolveJavaHome();
    if (javaHome) {
      env.JAVA_HOME = javaHome;
      env.PATH = `${path.join(javaHome, "bin")}${path.delimiter}${env.PATH ?? ""}`;
    }
    return env;
  }

  private requireSdk(): string {
    const sdk = resolveSdk();
    if (!sdk) {
      throw new Error(
        "Android SDK not found. Set nativeBuilds.androidSdkPath or the ANDROID_HOME environment variable."
      );
    }
    return sdk;
  }
}


function resolveSdk(): string | undefined {
  const configured = vscode.workspace
    .getConfiguration("nativeBuilds")
    .get<string>("androidSdkPath", "");
  const candidates = [
    configured,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), "Library", "Android", "sdk"),
    path.join(os.homedir(), "Android", "Sdk"),
    process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "Android", "Sdk")
      : undefined,
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, "platform-tools"))) {
      return c;
    }
  }
  return undefined;
}

function hasJava(home: string | undefined): home is string {
  return !!home && fs.existsSync(path.join(home, "bin", "java" + exeSuffix()));
}

function resolveJavaHome(): string | undefined {
  const configured = vscode.workspace
    .getConfiguration("nativeBuilds")
    .get<string>("javaHome", "");
  if (hasJava(configured)) {
    return configured;
  }
  if (hasJava(process.env.JAVA_HOME)) {
    return process.env.JAVA_HOME;
  }

  const studioJbr = (base: string) =>
    path.join(base, "Contents", "jbr", "Contents", "Home");
  const direct = [
    studioJbr("/Applications/Android Studio.app"),
    studioJbr("/Applications/Android Studio Preview.app"),
    studioJbr(path.join(os.homedir(), "Applications", "Android Studio.app")),
  ];
  for (const home of direct) {
    if (hasJava(home)) {
      return home;
    }
  }

  const jvmRoots = [
    "/Library/Java/JavaVirtualMachines",
    path.join(os.homedir(), "Library", "Java", "JavaVirtualMachines"),
  ];
  for (const root of jvmRoots) {
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const home = path.join(root, name, "Contents", "Home");
      if (hasJava(home)) {
        return home;
      }
    }
  }
  return undefined;
}

function exeSuffix(): string {
  return process.platform === "win32" ? ".exe" : "";
}

function adbPath(sdk: string): string {
  return path.join(sdk, "platform-tools", "adb" + exeSuffix());
}

function emulatorPath(sdk: string): string {
  return path.join(sdk, "emulator", "emulator" + exeSuffix());
}

async function globFiles(dir: string, fileName: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.name === fileName) {
        out.push(p);
      }
    }
  }
  await walk(dir);
  return out;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
