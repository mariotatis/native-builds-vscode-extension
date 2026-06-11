import * as vscode from "vscode";
import type {
  BuildCommandArgs,
  BuildModeOption,
  CommandSpec,
  Destination,
  LaunchArgs,
  Platform,
} from "./platform";
import { launch as launchProduct, resolveProduct } from "./run";
import { XcodeContainer, listDestinations, listSchemes } from "./xcode";

/**
 * Apple (iOS / iPadOS / macOS) toolchain. A thin adapter over the existing
 * xcode.ts / run.ts helpers — behavior is unchanged from the Xcode-only version.
 */
export class ApplePlatform implements Platform {
  readonly kind = "apple" as const;
  readonly schemeNoun = "scheme";
  readonly buildModes: BuildModeOption[] = [
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
  readonly projectName: string;

  constructor(private readonly container: XcodeContainer) {
    this.projectName = container.fileName;
  }

  listSchemes(_force: boolean): Promise<string[]> {
    return listSchemes(this.container);
  }

  listDestinations(includeAll: boolean): Promise<Destination[]> {
    return listDestinations(includeAll);
  }

  buildCommand({ scheme, destination, action }: BuildCommandArgs): CommandSpec {
    const cfg = vscode.workspace.getConfiguration("nativeBuilds");
    const flag = this.container.type === "workspace" ? "-workspace" : "-project";
    const args = [
      flag,
      this.container.fileName,
      "-scheme",
      scheme,
      "-destination",
      destination.value,
    ];
    if (cfg.get<boolean>("quiet", true)) {
      args.push("-quiet");
    }
    // action may be multi-word, e.g. "clean build".
    args.push(...action.split(/\s+/).filter(Boolean));
    args.push(...cfg.get<string[]>("additionalBuildArgs", []));

    return {
      command: "xcodebuild",
      args,
      cwd: this.container.dir,
      title: `${capitalize(action)} ${scheme} · ${destination.value}`,
      failureMarker: "BUILD FAILED",
    };
  }

  async launch({ scheme, destination, log }: LaunchArgs): Promise<void> {
    const product = await resolveProduct(this.container, scheme, destination.value);
    if (!product) {
      throw new Error("Could not locate the built .app from build settings.");
    }
    await launchProduct(destination, product, log);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
