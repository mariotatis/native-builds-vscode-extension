import * as vscode from "vscode";
import { ApplePlatform } from "./apple";
import { AndroidPlatform, findGradleApp } from "./android";
import { findXcodeContainers, pickPrimaryContainer } from "./xcode";

export interface Destination {
  label: string;
  detail?: string;
  value: string;
  group: "mac" | "device" | "simulator" | "generic" | "emulator";
}

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  title: string;
  failureMarker?: string;
}

export type BuildMode = "build" | "clean build" | "clean";

export interface BuildModeOption {
  mode: BuildMode;
  icon: string;
  label: string;
  short: string;
  description: string;
}

export interface BuildCommandArgs {
  scheme: string;
  destination: Destination;
  action: BuildMode;
}

export interface LaunchArgs {
  scheme: string;
  destination: Destination;
  log: (message: string) => void;
}

export interface Platform {
  readonly kind: "apple" | "android";
  readonly projectName: string;
  readonly schemeNoun: string;
  readonly buildModes: BuildModeOption[];
  listSchemes(force: boolean): Promise<string[]>;
  listDestinations(includeAll: boolean): Promise<Destination[]>;
  buildCommand(args: BuildCommandArgs): CommandSpec;
  parseBuildPhase(line: string): string | undefined;
  launch(args: LaunchArgs): Promise<void>;
}

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
