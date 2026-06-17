import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import type { Destination } from "./platform";

export type { Destination };

const execFileAsync = promisify(execFile);

export interface XcodeContainer {
  type: "workspace" | "project";
  absPath: string;
  fileName: string;
  dir: string;
  name: string;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "Pods",
  "Carthage",
  "build",
  "DerivedData",
  ".build",
  "vendor",
  ".swiftpm",
]);

export async function findXcodeContainers(
  root: string,
  maxDepth = 3
): Promise<XcodeContainer[]> {
  const found: XcodeContainer[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const name = entry.name;
      const abs = path.join(dir, name);

      if (name.endsWith(".xcworkspace")) {
        found.push(makeContainer("workspace", abs));
        continue;
      }
      if (name.endsWith(".xcodeproj")) {
        found.push(makeContainer("project", abs));
        continue;
      }
      if (IGNORED_DIRS.has(name) || name.startsWith(".")) {
        continue;
      }
      if (depth < maxDepth) {
        await walk(abs, depth + 1);
      }
    }
  }

  await walk(root, 0);
  return found;
}

function makeContainer(
  type: "workspace" | "project",
  absPath: string
): XcodeContainer {
  const fileName = path.basename(absPath);
  return {
    type,
    absPath,
    fileName,
    dir: path.dirname(absPath),
    name: fileName.replace(/\.(xcworkspace|xcodeproj)$/, ""),
  };
}

export function pickPrimaryContainer(
  containers: XcodeContainer[]
): XcodeContainer | undefined {
  if (containers.length === 0) {
    return undefined;
  }
  const workspaces = containers.filter((c) => c.type === "workspace");
  for (const ws of workspaces) {
    const hasSiblingProject = containers.some(
      (c) => c.type === "project" && c.dir === ws.dir
    );
    if (hasSiblingProject) {
      return ws;
    }
  }
  return [...containers].sort((a, b) => {
    const da = a.absPath.split(path.sep).length;
    const db = b.absPath.split(path.sep).length;
    if (da !== db) {
      return da - db;
    }
    return a.type === "workspace" ? -1 : 1;
  })[0];
}

export async function listSchemes(container: XcodeContainer): Promise<string[]> {
  const flag = container.type === "workspace" ? "-workspace" : "-project";
  const { stdout } = await execFileAsync(
    "xcodebuild",
    ["-list", "-json", flag, container.absPath],
    { cwd: container.dir, maxBuffer: 1024 * 1024 * 16, timeout: 60_000 }
  );

  const start = stdout.indexOf("{");
  if (start < 0) {
    return [];
  }
  const parsed = JSON.parse(stdout.slice(start));
  const schemes: string[] | undefined =
    parsed?.workspace?.schemes ?? parsed?.project?.schemes;
  return Array.isArray(schemes) ? schemes : [];
}

interface SimctlDevice {
  name: string;
  udid: string;
  state: string;
  isAvailable?: boolean;
}

export async function listDestinations(
  includeAllSimulators: boolean
): Promise<Destination[]> {
  const macArch = process.arch === "arm64" ? "arm64" : "x86_64";
  const destinations: Destination[] = [
    {
      label: "My Mac",
      value: `platform=macOS,arch=${macArch}`,
      group: "mac",
    },
  ];

  const [physical, simulators] = await Promise.all([
    listPhysicalDevices().catch(() => [] as Destination[]),
    listSimulators(includeAllSimulators).catch(() => [] as Destination[]),
  ]);

  destinations.push(...physical, ...simulators);

  destinations.push(
    {
      label: "Any iOS Device",
      detail: "generic/platform=iOS",
      value: "generic/platform=iOS",
      group: "generic",
    },
    {
      label: "Any iOS Simulator",
      detail: "generic/platform=iOS Simulator",
      value: "generic/platform=iOS Simulator",
      group: "generic",
    }
  );

  return destinations;
}

async function listSimulators(
  includeAll: boolean
): Promise<Destination[]> {
  const { stdout } = await execFileAsync(
    "xcrun",
    ["simctl", "list", "devices", "available", "--json"],
    { maxBuffer: 1024 * 1024 * 16, timeout: 30_000 }
  );
  const parsed = JSON.parse(stdout) as {
    devices: Record<string, SimctlDevice[]>;
  };

  const out: Destination[] = [];
  for (const [runtimeId, devices] of Object.entries(parsed.devices)) {
    const platform = runtimePlatform(runtimeId);
    if (!platform) {
      continue;
    }
    if (!includeAll && platform.simPlatform !== "iOS Simulator") {
      continue;
    }
    for (const device of devices) {
      if (device.isAvailable === false) {
        continue;
      }
      out.push({
        label: `${device.name} (${platform.display})`,
        detail:
          device.state === "Booted" ? "Simulator · Booted" : "Simulator",
        value: `platform=${platform.simPlatform},id=${device.udid}`,
        group: "simulator",
      });
    }
  }

  out.sort((a, b) => {
    const aBoot = a.detail?.includes("Booted") ? 0 : 1;
    const bBoot = b.detail?.includes("Booted") ? 0 : 1;
    if (aBoot !== bBoot) {
      return aBoot - bBoot;
    }
    return a.label.localeCompare(b.label);
  });
  return out;
}

function runtimePlatform(
  runtimeId: string
): { simPlatform: string; display: string } | undefined {
  const tail = runtimeId.split(".SimRuntime.")[1];
  if (!tail) {
    return undefined;
  }
  const match = tail.match(/^([A-Za-z]+)-(\d+)-(\d+)/);
  if (!match) {
    return undefined;
  }
  const [, osRaw, major, minor] = match;
  const version = `${major}.${minor}`;
  switch (osRaw) {
    case "iOS":
      return { simPlatform: "iOS Simulator", display: `iOS ${version}` };
    case "watchOS":
      return { simPlatform: "watchOS Simulator", display: `watchOS ${version}` };
    case "tvOS":
      return { simPlatform: "tvOS Simulator", display: `tvOS ${version}` };
    case "xrOS":
    case "visionOS":
      return {
        simPlatform: "visionOS Simulator",
        display: `visionOS ${version}`,
      };
    default:
      return undefined;
  }
}

async function listPhysicalDevices(): Promise<Destination[]> {
  const { stdout } = await execFileAsync("xcrun", ["xctrace", "list", "devices"], {
    maxBuffer: 1024 * 1024 * 8,
    timeout: 20_000,
  });

  const out: Destination[] = [];
  let inDevices = false;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("==")) {
      inDevices = /Devices/i.test(line) && !/Offline/i.test(line);
      continue;
    }
    if (!inDevices || !line) {
      continue;
    }
    const withVersion = line.match(/^(.*) \(([\d.]+)\) \(([0-9A-Fa-f-]{8,})\)$/);
    if (withVersion) {
      const [, name, version, udid] = withVersion;
      out.push({
        label: `${name} (${version})`,
        detail: "Connected device",
        value: `platform=iOS,id=${udid}`,
        group: "device",
      });
      continue;
    }
  }
  return out;
}
