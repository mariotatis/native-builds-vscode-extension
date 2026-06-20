import * as vscode from "vscode";
import { Builder } from "./builder";
import { BuildMode, Destination, Platform, detectPlatform } from "./platform";

const STATE_SCHEME = "nativeBuilds.scheme";
const STATE_DESTINATION = "nativeBuilds.destination";

type Action = "build" | "run";

let controller: NativeBuildsController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  controller = new NativeBuildsController(context);
  context.subscriptions.push(controller);
  await controller.initialize();
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}

class NativeBuildsController {
  private readonly context: vscode.ExtensionContext;
  private readonly output: vscode.OutputChannel;
  private readonly builder: Builder;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly schemeItem: vscode.StatusBarItem;
  private readonly destinationItem: vscode.StatusBarItem;
  private readonly buildItem: vscode.StatusBarItem;
  private readonly buildMenuItem: vscode.StatusBarItem;
  private readonly runItem: vscode.StatusBarItem;
  private readonly stopItem: vscode.StatusBarItem;

  private platform: Platform | undefined;
  private schemes: string[] = [];
  private destinations: Destination[] = [];
  private scheme: string | undefined;
  private destination: Destination | undefined;
  private activeAction: Action | undefined;
  private activeMode: BuildMode = "build";
  private activePhase: string | undefined;
  private running: Promise<void> | undefined;
  private restarting = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.output = vscode.window.createOutputChannel("Native Builds");
    this.builder = new Builder(this.output);

    this.schemeItem = mkItem(105);
    this.destinationItem = mkItem(104);
    this.buildItem = mkItem(103);
    this.buildMenuItem = mkItem(102);
    this.runItem = mkItem(101);
    this.stopItem = mkItem(100);

    this.schemeItem.command = "nativeBuilds.selectScheme";
    this.destinationItem.command = "nativeBuilds.selectDestination";
    this.buildItem.command = "nativeBuilds.build";
    this.buildMenuItem.command = "nativeBuilds.buildMenu";
    this.runItem.command = "nativeBuilds.run";
    this.stopItem.command = "nativeBuilds.stop";

    this.disposables.push(
      this.output,
      this.schemeItem,
      this.destinationItem,
      this.buildItem,
      this.buildMenuItem,
      this.runItem,
      this.stopItem,
      this.builder,
      vscode.commands.registerCommand("nativeBuilds.selectScheme", () =>
        this.selectScheme()
      ),
      vscode.commands.registerCommand("nativeBuilds.selectDestination", () =>
        this.selectDestination()
      ),
      vscode.commands.registerCommand("nativeBuilds.build", () =>
        this.execute("build")
      ),
      vscode.commands.registerCommand("nativeBuilds.buildMenu", () =>
        this.showBuildMenu()
      ),
      vscode.commands.registerCommand("nativeBuilds.run", () => this.execute("run")),
      vscode.commands.registerCommand("nativeBuilds.stop", () =>
        this.builder.stop()
      ),
      vscode.commands.registerCommand("nativeBuilds.refresh", () =>
        this.initialize(true)
      ),
      vscode.commands.registerCommand("nativeBuilds.showOutput", () =>
        this.builder.showOutput()
      ),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.initialize()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("nativeBuilds.includeAllSimulators")) {
          void this.loadDestinations(true).then(() => this.render());
        }
      })
    );
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  async initialize(forceRefresh = false): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.hideAll();
      return;
    }

    this.platform = await detectPlatform(folders, this.output);
    if (!this.platform) {
      this.hideAll();
      return;
    }

    this.showAll();
    await this.loadSchemes(forceRefresh);
    await this.loadDestinations(forceRefresh);
    this.render();
  }

  private async loadSchemes(forceRefresh: boolean): Promise<void> {
    if (!this.platform) {
      return;
    }
    const noun = this.platform.schemeNoun;
    this.schemeItem.text = `$(sync~spin) Loading ${noun}s…`;
    try {
      this.schemes = await this.platform.listSchemes(forceRefresh);
    } catch (err) {
      this.schemes = [];
      vscode.window.showErrorMessage(
        `Native Builds: could not list ${noun}s — ${errMsg(err)}`
      );
    }

    const saved = this.context.workspaceState.get<string>(STATE_SCHEME);
    if (!forceRefresh && saved && this.schemes.includes(saved)) {
      this.scheme = saved;
    } else if (this.scheme && this.schemes.includes(this.scheme)) {
    } else {
      this.scheme = this.schemes[0];
    }
  }

  private async loadDestinations(forceRefresh: boolean): Promise<void> {
    if (!this.platform) {
      return;
    }
    this.destinationItem.text = "$(sync~spin) Loading devices…";
    const includeAll = config().get<boolean>("includeAllSimulators", false);
    try {
      this.destinations = await this.platform.listDestinations(includeAll);
    } catch (err) {
      this.destinations = [];
      vscode.window.showErrorMessage(
        `Native Builds: could not list devices — ${errMsg(err)}`
      );
    }

    const saved = this.context.workspaceState.get<string>(STATE_DESTINATION);
    const findByValue = (value?: string) =>
      this.destinations.find((d) => d.value === value);

    if (!forceRefresh && findByValue(saved)) {
      this.destination = findByValue(saved);
    } else if (this.destination && findByValue(this.destination.value)) {
    } else {
      this.destination = this.destinations[0];
    }
  }

  private async selectScheme(): Promise<void> {
    const noun = this.platform?.schemeNoun ?? "scheme";
    if (this.schemes.length === 0) {
      await this.loadSchemes(true);
    }
    if (this.schemes.length === 0) {
      vscode.window.showWarningMessage(`Native Builds: no ${noun}s found.`);
      this.render();
      return;
    }
    const pick = await vscode.window.showQuickPick(this.schemes, {
      placeHolder: `Select the ${noun} to build`,
    });
    if (pick) {
      this.scheme = pick;
      await this.context.workspaceState.update(STATE_SCHEME, pick);
    }
    this.render();
  }

  private async selectDestination(): Promise<void> {
    if (this.destinations.length === 0) {
      await this.loadDestinations(true);
    }
    const items = buildDestinationQuickPick(this.destinations);
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Select the device / destination to build for",
      matchOnDetail: true,
    });
    if (pick && pick.destination) {
      this.destination = pick.destination;
      await this.context.workspaceState.update(
        STATE_DESTINATION,
        pick.destination.value
      );
    }
    this.render();
  }

  private async execute(action: Action, mode: BuildMode = "build"): Promise<void> {
    if (!this.platform) {
      vscode.window.showWarningMessage(
        "Native Builds: no Xcode or Gradle project detected."
      );
      return;
    }
    if (this.activeAction) {
      await this.stopActive();
    }
    if (!this.scheme) {
      await this.selectScheme();
      if (!this.scheme) {
        return;
      }
    }
    if (!this.destination) {
      await this.selectDestination();
      if (!this.destination) {
        return;
      }
    }
    if (action === "run" && this.destination.group === "generic") {
      vscode.window.showWarningMessage(
        "Native Builds: pick a concrete device to run (not a generic destination)."
      );
      return;
    }

    this.activeAction = action;
    this.activeMode = mode;
    this.activePhase = undefined;
    this.render();
    this.running = this.doWork(action, mode);
    try {
      await this.running;
    } finally {
      this.running = undefined;
      this.activeAction = undefined;
      this.activeMode = "build";
      this.activePhase = undefined;
      this.render();
    }
  }

  private async showBuildMenu(): Promise<void> {
    if (!this.platform) {
      return;
    }
    const pick = await vscode.window.showQuickPick(
      this.platform.buildModes.map((m) => ({
        label: `${m.icon} ${m.label}`,
        description: m.description,
        mode: m.mode,
      })),
      { placeHolder: "Choose a build action to run now" }
    );
    if (!pick) {
      return;
    }
    await this.execute("build", pick.mode);
  }

  private async stopActive(): Promise<void> {
    this.restarting = true;
    this.builder.stop();
    if (this.running) {
      try {
        await this.running;
      } catch {
      }
    }
    this.restarting = false;
  }

  private async doWork(action: Action, mode: BuildMode): Promise<void> {
    if (!this.platform || !this.scheme || !this.destination) {
      return;
    }
    const cfg = config();
    const buildAction = action === "run" ? "build" : mode;

    const spec = this.platform.buildCommand({
      scheme: this.scheme,
      destination: this.destination,
      action: buildAction,
    });
    const result = await this.builder.run(spec, {
      outputFilter: cfg.get<string>("outputFilter", ""),
      reveal: cfg.get<"never" | "onError" | "always">("revealOutput", "onError"),
      parsePhase: (line) => this.platform?.parseBuildPhase(line),
      onPhase: (phase) => this.setPhase(phase),
    });

    if (result.cancelled) {
      if (!this.restarting) {
        vscode.window.setStatusBarMessage("$(debug-stop) Native Builds stopped", 4000);
      }
      return;
    }
    if (!result.succeeded) {
      const choice = await vscode.window.showErrorMessage(
        "Native Builds failed.",
        "Show Output"
      );
      if (choice === "Show Output") {
        this.builder.showOutput();
      }
      return;
    }

    if (action === "build") {
      vscode.window.setStatusBarMessage("$(check) Native Builds succeeded", 5000);
      return;
    }

    await this.launchProduct();
  }

  private async launchProduct(): Promise<void> {
    if (!this.platform || !this.scheme || !this.destination) {
      return;
    }
    try {
      await this.platform.launch({
        scheme: this.scheme,
        destination: this.destination,
        log: (m) => {
          this.builder.log(m);
          const phase = parseLaunchPhase(m);
          if (phase) {
            this.setPhase(phase);
          }
        },
      });
      vscode.window.setStatusBarMessage("$(rocket) Native Builds running", 5000);
    } catch (err) {
      this.builder.log(`❌ ${errMsg(err)}`);
      const choice = await vscode.window.showErrorMessage(
        `Native Builds: run failed — ${errMsg(err)}`,
        "Show Output"
      );
      if (choice === "Show Output") {
        this.builder.showOutput();
      }
    }
  }

  private setPhase(phase: string | undefined): void {
    if (this.activePhase === phase) {
      return;
    }
    this.activePhase = phase;
    this.render();
  }


  private render(): void {
    if (!this.platform) {
      return;
    }
    const noun = this.platform.schemeNoun;
    const Noun = capitalize(noun);
    this.schemeItem.text = `$(layers) ${this.scheme ?? `No ${noun}`}`;
    this.schemeItem.tooltip = `Native Builds · ${this.platform.projectName}\n${Noun}: ${
      this.scheme ?? "none"
    }\nClick to change ${noun}`;

    const destIcon = this.destination
      ? destinationIconId(this.destination)
      : "device-mobile";
    this.destinationItem.text = `$(${destIcon}) ${
      this.destination?.label ?? "No device"
    }`;
    this.destinationItem.tooltip = `Destination: ${
      this.destination?.value ?? "none"
    }\nClick to change device`;

    const warnBg = new vscode.ThemeColor("statusBarItem.warningBackground");
    const busy = this.activeAction !== undefined;

    const phase = this.activePhase ? ` ${this.activePhase}` : "";
    const quietHint =
      this.platform.kind === "apple" && config().get<boolean>("quiet", true)
        ? "\n\nTip: set nativeBuilds.quiet to false to show build phases (Compiling/Linking/Signing)."
        : "";

    if (this.activeAction === "build") {
      const verb =
        this.activeMode === "clean"
          ? "Cleaning…"
          : this.activeMode === "clean build"
          ? "Cleaning + Building…"
          : "Building…";
      this.buildItem.text = `$(sync~spin) ${verb}${phase}`;
      this.buildItem.tooltip = `${verb} click to restart (cancels the current build)${quietHint}`;
      this.buildItem.backgroundColor = warnBg;
    } else {
      this.buildItem.text = "$(tools) Build";
      this.buildItem.tooltip = busy
        ? `Cancel the current ${this.activeAction} and build ${this.scheme ?? "?"}`
        : `Build ${this.scheme ?? "?"} for ${this.destination?.label ?? "?"}`;
      this.buildItem.backgroundColor = undefined;
    }

    this.buildMenuItem.text = "$(chevron-down)";
    this.buildMenuItem.tooltip = "Run a build action (Build / Clean…)";

    if (this.activeAction === "run") {
      this.runItem.text = `$(sync~spin) Running…${phase}`;
      this.runItem.tooltip = `Running… click to re-run (cancels the current run)${quietHint}`;
      this.runItem.backgroundColor = warnBg;
    } else {
      this.runItem.text = "$(play) Run";
      this.runItem.tooltip = busy
        ? `Cancel the current ${this.activeAction} and run ${this.scheme ?? "?"}`
        : `Build & run ${this.scheme ?? "?"} on ${this.destination?.label ?? "?"}`;
      this.runItem.backgroundColor = undefined;
    }

    this.stopItem.text = "$(debug-stop) Stop";
    this.stopItem.tooltip = "Stop the current build/run";
    this.stopItem.backgroundColor = warnBg;
    if (busy) {
      this.stopItem.show();
    } else {
      this.stopItem.hide();
    }
  }

  private showAll(): void {
    this.schemeItem.show();
    this.destinationItem.show();
    this.buildItem.show();
    this.buildMenuItem.show();
    this.runItem.show();
  }

  private hideAll(): void {
    this.platform = undefined;
    this.schemeItem.hide();
    this.destinationItem.hide();
    this.buildItem.hide();
    this.buildMenuItem.hide();
    this.runItem.hide();
    this.stopItem.hide();
  }
}


interface DestinationQuickPickItem extends vscode.QuickPickItem {
  destination?: Destination;
}

function mkItem(priority: number): vscode.StatusBarItem {
  return vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    priority
  );
}

function buildDestinationQuickPick(
  destinations: Destination[]
): DestinationQuickPickItem[] {
  const groupLabels: Record<Destination["group"], string> = {
    mac: "macOS",
    device: "Connected Devices",
    emulator: "Emulators",
    simulator: "Simulators",
    generic: "Generic",
  };
  const order: Destination["group"][] = [
    "mac",
    "device",
    "emulator",
    "simulator",
    "generic",
  ];

  const items: DestinationQuickPickItem[] = [];
  for (const group of order) {
    const inGroup = destinations.filter((d) => d.group === group);
    if (inGroup.length === 0) {
      continue;
    }
    items.push({
      label: groupLabels[group],
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const d of inGroup) {
      items.push({
        label: d.label,
        detail: d.detail,
        iconPath: new vscode.ThemeIcon(destinationIconId(d)),
        destination: d,
      });
    }
  }
  return items;
}

function parseLaunchPhase(line: string): string | undefined {
  if (/Booting|Waiting for the emulator/i.test(line)) {
    return "Booting…";
  }
  if (/Locating APK/i.test(line)) {
    return "Locating APK…";
  }
  if (/Installing/i.test(line)) {
    return "Installing…";
  }
  if (/Launching|Launched/i.test(line)) {
    return "Launching…";
  }
  return undefined;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("nativeBuilds");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Picks a codicon / contributed-icon id that matches the destination's device
// type, so a Mac shows a display, an iPad a tablet, an Apple TV a TV, etc.
// `apple-build-tablet` and `apple-build-tv` are contributed in package.json
// (no built-in codicon exists for those shapes); the rest are stock codicons.
function destinationIconId(dest: Destination): string {
  const value = dest.value.toLowerCase();
  const label = dest.label.toLowerCase();

  // macOS → display
  if (dest.group === "mac" || value.includes("platform=macos")) {
    return "device-desktop";
  }
  // visionOS / Apple Vision Pro → VR headset
  if (value.includes("visionos") || value.includes("xros") || label.includes("vision")) {
    return "vr";
  }
  // watchOS / Apple Watch / Wear OS → watch
  if (value.includes("watchos") || label.includes("watch") || label.includes("wear")) {
    return "watch";
  }
  // tvOS / Apple TV / Android TV → TV
  if (
    value.includes("tvos") ||
    label.includes("apple tv") ||
    label.includes("android tv") ||
    /(^|[\s_-])tv([\s_-]|\d|$)/.test(label)
  ) {
    return "apple-build-tv";
  }
  // iPad / Android tablet → tablet
  if (label.includes("ipad") || label.includes("tablet")) {
    return "apple-build-tablet";
  }
  // iPhone / Android phone / generic iOS → phone
  return "device-mobile";
}
