import * as vscode from "vscode";
import { ApplePlatform } from "./apple";
import { AndroidPlatform, findGradleApp } from "./android";
import { findXcodeContainers, pickPrimaryContainer } from "./xcode";

/** A build destination shown in the device picker (Apple sims/devices or Android emulators/devices). */
export interface Destination {
  /** Human label shown in the status bar / quick pick, e.g. "iPhone 15 (iOS 17.2)" or "Pixel_10_Pro_XL". */
  label: string;
  /** Optional secondary line in the quick pick. */
  detail?: string;
  /**
   * Toolchain-specific target identifier. Apple: the `xcodebuild -destination`
   * string. Android: `avd=<name>` or `serial=<adb-serial>`.
   */
  value: string;
  /** Rough grouping for the quick pick separators. */
  group: "mac" | "device" | "simulator" | "generic" | "emulator";
}

/** A command for the {@link Builder} to spawn and stream. */
export interface CommandSpec {
  /** Executable (absolute path or PATH name), e.g. "xcodebuild" or "/.../gradlew". */
  command: string;
  args: string[];
  /** Working directory for the child process. */
  cwd: string;
  /** Extra environment merged over process.env (e.g. ANDROID_HOME for Gradle). */
  env?: NodeJS.ProcessEnv;
  /** Header line shown in the output channel, e.g. "Build MyScheme · <dest>". */
  title: string;
  /**
   * Optional substring that, if seen in output, forces a failure even on exit 0
   * (xcodebuild prints "BUILD FAILED"). Omit to trust the exit code (Gradle).
   */
  failureMarker?: string;
}

/** Abstract build action chosen from the Build-button dropdown. */
export type BuildMode = "build" | "clean build" | "clean";

/** Presentation for one entry in the Build-action dropdown / button. */
export interface BuildModeOption {
  mode: BuildMode;
  /** Codicon shown on the status bar button, e.g. "$(tools)". */
  icon: string;
  /** Full label shown in the dropdown. */
  label: string;
  /** Short label for the status bar button. */
  short: string;
  /** Subtitle shown in the dropdown, e.g. "xcodebuild clean build". */
  description: string;
}

export interface BuildCommandArgs {
  /** The selected scheme (Apple) or build variant (Android). */
  scheme: string;
  destination: Destination;
  action: BuildMode;
}

export interface LaunchArgs {
  scheme: string;
  destination: Destination;
  log: (message: string) => void;
}

/**
 * A build toolchain the status bar can drive. Apple (xcodebuild) and Android
 * (Gradle) each implement this; the controller stays toolchain-agnostic.
 */
export interface Platform {
  readonly kind: "apple" | "android";
  /** Shown in the scheme item's tooltip, e.g. "MyApp.xcodeproj" or "app (Gradle)". */
  readonly projectName: string;
  /** Noun for the scheme/variant picker — "scheme" or "variant". */
  readonly schemeNoun: string;
  /** Build-action dropdown entries (toolchain-specific labels/subtitles). */
  readonly buildModes: BuildModeOption[];
  /** List schemes (Apple) or build variants (Android). */
  listSchemes(force: boolean): Promise<string[]>;
  /** List runnable destinations (sims/devices or emulators/devices). */
  listDestinations(includeAll: boolean): Promise<Destination[]>;
  /** Produce the command the Builder runs for the given action. */
  buildCommand(args: BuildCommandArgs): CommandSpec;
  /** After a successful run-build, install + launch on the destination. */
  launch(args: LaunchArgs): Promise<void>;
}

/**
 * Detect which toolchain drives this workspace. Apple wins when an Xcode
 * container is present (keeps existing behavior in mixed repos); otherwise we
 * look for a Gradle/Android application module. Returns undefined when neither
 * is found, in which case the status bar hides.
 */
export async function detectPlatform(
  folders: readonly vscode.WorkspaceFolder[],
  output: vscode.OutputChannel
): Promise<Platform | undefined> {
  const containers = [];
  for (const folder of folders) {
    containers.push(...(await findXcodeContainers(folder.uri.fsPath)));
  }
  const primary = pickPrimaryContainer(containers);
  if (primary) {
    return new ApplePlatform(primary);
  }

  for (const folder of folders) {
    const app = await findGradleApp(folder.uri.fsPath);
    if (app) {
      return new AndroidPlatform(app, output);
    }
  }
  return undefined;
}
