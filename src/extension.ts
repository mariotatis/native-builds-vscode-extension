import * as vscode from "vscode";
import { Builder } from "./builder";
import { launch, resolveProduct } from "./run";
import {
  Destination,
  XcodeContainer,
  findXcodeContainers,
  listDestinations,
  listSchemes,
  pickPrimaryContainer,
} from "./xcode";

const STATE_SCHEME = "nativeBuilds.scheme";
const STATE_DESTINATION = "nativeBuilds.destination";
const STATE_BUILD_MODE = "nativeBuilds.buildMode";

type Action = "build" | "run";

/** xcodebuild action chosen from the Build button dropdown. */
type BuildMode = "build" | "clean build" | "clean";

interface BuildModeOption {
  mode: BuildMode;
  /** Codicon shown on the status bar button, e.g. "$(tools)". */
  icon: string;
  /** Full label shown in the dropdown. */
  label: string;
  /** Short label for the status bar button. */
  short: string;
  description: string;
}

const BUILD_MODES: BuildModeOption[] = [
  {
    mode: "build",
    icon: "$(tools)",
    label: "Build",
    short: "Build",
    description: "xcodebuild build",
  },
  {
    mode: "clean build",
    icon: "$(sync)",
    label: "Clean Build Folder, then Build",
    short: "Clean Build",
    description: "xcodebuild clean build",
  },
  {
    mode: "clean",
    icon: "$(trash)",
    label: "Clean Build Folder",
    short: "Clean",
    description: "xcodebuild clean",
  },
];

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

  private container: XcodeContainer | undefined;
  private schemes: string[] = [];
  private destinations: Destination[] = [];
  private scheme: string | undefined;
  private destination: Destination | undefined;
  private activeAction: Action | undefined;
  /** Which xcodebuild action the Build button runs. */
  private buildMode: BuildMode = "build";
  /** Promise for the in-flight build+launch, used to await a clean restart. */
  private running: Promise<void> | undefined;
  /** True while we are tearing down a build to immediately start another. */
  private restarting = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.output = vscode.window.createOutputChannel("Native Builds");
    this.builder = new Builder(this.output);

    this.buildMode =
      context.workspaceState.get<BuildMode>(STATE_BUILD_MODE) ?? "build";

    // Left-aligned group; higher priority renders further left.
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
        // The device list depends on this setting; refresh it live.
        if (e.affectsConfiguration("nativeBuilds.includeAllSimulators")) {
          void this.loadDestinations(true).then(() => this.render());
        }
      })
    );
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  /** Detect the project and populate the status bar. */
  async initialize(forceRefresh = false): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.hideAll();
      return;
    }

    const containers: XcodeContainer[] = [];
    for (const folder of folders) {
      containers.push(...(await findXcodeContainers(folder.uri.fsPath)));
    }

    const primary = pickPrimaryContainer(containers);
    if (!primary) {
      this.hideAll();
      return;
    }
    this.container = primary;

    this.showAll();
    await this.loadSchemes(forceRefresh);
    await this.loadDestinations(forceRefresh);
    this.render();
  }

  private async loadSchemes(forceRefresh: boolean): Promise<void> {
    if (!this.container) {
      return;
    }
    this.schemeItem.text = "$(sync~spin) Loading schemes…";
    try {
      this.schemes = await listSchemes(this.container);
    } catch (err) {
      this.schemes = [];
      vscode.window.showErrorMessage(
        `Native Builds: could not list schemes — ${errMsg(err)}`
      );
    }

    const saved = this.context.workspaceState.get<string>(STATE_SCHEME);
    if (!forceRefresh && saved && this.schemes.includes(saved)) {
      this.scheme = saved;
    } else if (this.scheme && this.schemes.includes(this.scheme)) {
      // keep current
    } else {
      this.scheme = this.schemes[0];
    }
  }

  private async loadDestinations(forceRefresh: boolean): Promise<void> {
    this.destinationItem.text = "$(sync~spin) Loading devices…";
    const includeAll = config().get<boolean>("includeAllSimulators", false);
    try {
      this.destinations = await listDestinations(includeAll);
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
      // keep current
    } else {
      this.destination = this.destinations[0];
    }
  }

  private async selectScheme(): Promise<void> {
    if (this.schemes.length === 0) {
      await this.loadSchemes(true);
    }
    if (this.schemes.length === 0) {
      vscode.window.showWarningMessage("Native Builds: no schemes found.");
      this.render();
      return;
    }
    const pick = await vscode.window.showQuickPick(this.schemes, {
      placeHolder: "Select the Xcode scheme (target) to build",
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

  /** Shared entry point for the Build and Run buttons. */
  private async execute(action: Action): Promise<void> {
    if (!this.container) {
      vscode.window.showWarningMessage("Native Builds: no Xcode project detected.");
      return;
    }
    // If something is already building/running, stop it and start fresh.
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
    this.render();
    this.running = this.doWork(action);
    try {
      await this.running;
    } finally {
      this.running = undefined;
      this.activeAction = undefined;
      this.render();
    }
  }

  /**
   * Show the Build-action dropdown and remember the choice. This only changes
   * which action the Build button will run — it does not build anything.
   */
  private async showBuildMenu(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      BUILD_MODES.map((m) => ({
        label: `${m.icon} ${m.label}`,
        description: m.description,
        picked: m.mode === this.buildMode,
        mode: m.mode,
      })),
      { placeHolder: "Choose the build action for the Build button" }
    );
    if (!pick) {
      return;
    }
    this.buildMode = pick.mode;
    await this.context.workspaceState.update(STATE_BUILD_MODE, pick.mode);
    this.render();
  }

  /** Cancel the in-flight build/run and wait for it to fully terminate. */
  private async stopActive(): Promise<void> {
    this.restarting = true;
    this.builder.stop();
    if (this.running) {
      try {
        await this.running;
      } catch {
        // Swallow — we only care that the previous work has finished.
      }
    }
    this.restarting = false;
  }

  /** Run xcodebuild and, for the run action, install + launch the product. */
  private async doWork(action: Action): Promise<void> {
    if (!this.container || !this.scheme || !this.destination) {
      return;
    }
    const cfg = config();
    // Run always plain-builds; the Build button uses the chosen build mode.
    const buildAction = action === "run" ? "build" : this.buildMode;

    const result = await this.builder.run({
      container: this.container,
      scheme: this.scheme,
      destination: this.destination.value,
      action: buildAction,
      extraArgs: cfg.get<string[]>("additionalBuildArgs", []),
      outputFilter: cfg.get<string>("outputFilter", ""),
      quiet: cfg.get<boolean>("quiet", true),
      reveal: cfg.get<"never" | "onError" | "always">("revealOutput", "onError"),
    });

    if (result.cancelled) {
      // A user-initiated restart will start its own build; stay quiet then.
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

    // action === "run": locate the product and launch it.
    await this.launchProduct();
  }

  private async launchProduct(): Promise<void> {
    if (!this.container || !this.scheme || !this.destination) {
      return;
    }
    try {
      const product = await resolveProduct(
        this.container,
        this.scheme,
        this.destination.value
      );
      if (!product) {
        throw new Error("Could not locate the built .app from build settings.");
      }
      await launch(this.destination, product, (m) => this.builder.log(m));
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

  // --- rendering ---------------------------------------------------------

  private render(): void {
    if (!this.container) {
      return;
    }
    this.schemeItem.text = `$(layers) ${this.scheme ?? "No scheme"}`;
    this.schemeItem.tooltip = `Native Builds · ${this.container.fileName}\nScheme: ${
      this.scheme ?? "none"
    }\nClick to change scheme`;

    this.destinationItem.text = `$(device-mobile) ${
      this.destination?.label ?? "No device"
    }`;
    this.destinationItem.tooltip = `Destination: ${
      this.destination?.value ?? "none"
    }\nClick to change device`;

    const warnBg = new vscode.ThemeColor("statusBarItem.warningBackground");
    const busy = this.activeAction !== undefined;

    const mode = BUILD_MODES.find((m) => m.mode === this.buildMode) ?? BUILD_MODES[0];

    if (this.activeAction === "build") {
      const verb = this.buildMode === "clean" ? "Cleaning…" : "Building…";
      this.buildItem.text = `$(sync~spin) ${verb}`;
      this.buildItem.tooltip = `${verb} click to restart (cancels the current build)`;
      this.buildItem.backgroundColor = warnBg;
    } else {
      this.buildItem.text = `${mode.icon} ${mode.short}`;
      this.buildItem.tooltip = busy
        ? `Cancel the current ${this.activeAction} and run "${mode.description}"`
        : `${mode.description} — ${this.scheme ?? "?"} for ${
            this.destination?.label ?? "?"
          }`;
      this.buildItem.backgroundColor = undefined;
    }

    // Caret next to Build: opens the build-action dropdown.
    this.buildMenuItem.text = "$(chevron-down)";
    this.buildMenuItem.tooltip = "Choose build action (Build / Clean Build Folder)";

    if (this.activeAction === "run") {
      this.runItem.text = "$(sync~spin) Running…";
      this.runItem.tooltip = "Running… click to re-run (cancels the current run)";
      this.runItem.backgroundColor = warnBg;
    } else {
      this.runItem.text = "$(play) Run";
      this.runItem.tooltip = busy
        ? `Cancel the current ${this.activeAction} and run ${this.scheme ?? "?"}`
        : `Build & run ${this.scheme ?? "?"} on ${this.destination?.label ?? "?"}`;
      this.runItem.backgroundColor = undefined;
    }

    // Dedicated Stop button, visible only while a build/run is in flight.
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
    this.container = undefined;
    this.schemeItem.hide();
    this.destinationItem.hide();
    this.buildItem.hide();
    this.buildMenuItem.hide();
    this.runItem.hide();
    this.stopItem.hide();
  }
}

// --- helpers -------------------------------------------------------------

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
    simulator: "Simulators",
    generic: "Generic",
  };
  const order: Destination["group"][] = ["mac", "device", "simulator", "generic"];

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
        destination: d,
      });
    }
  }
  return items;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("nativeBuilds");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
