import { execFile } from "child_process";
import { promisify } from "util";
import { Destination, XcodeContainer } from "./xcode";

const run = promisify(execFile);
const OPTS = { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 };

export interface ProductInfo {
  appPath: string;
  bundleId?: string;
}

export async function resolveProduct(
  container: XcodeContainer,
  scheme: string,
  destination: string
): Promise<ProductInfo | undefined> {
  const flag = container.type === "workspace" ? "-workspace" : "-project";
  const { stdout } = await run(
    "xcodebuild",
    [
      flag,
      container.fileName,
      "-scheme",
      scheme,
      "-destination",
      destination,
      "-showBuildSettings",
      "-json",
    ],
    { cwd: container.dir, ...OPTS }
  );

  const start = stdout.indexOf("[");
  if (start < 0) {
    return undefined;
  }
  const entries = JSON.parse(stdout.slice(start)) as Array<{
    buildSettings?: Record<string, string>;
  }>;

  for (const entry of entries) {
    const bs = entry.buildSettings;
    const dir = bs?.TARGET_BUILD_DIR;
    const name = bs?.WRAPPER_NAME ?? bs?.FULL_PRODUCT_NAME;
    if (dir && name && name.endsWith(".app")) {
      return { appPath: `${dir}/${name}`, bundleId: bs?.PRODUCT_BUNDLE_IDENTIFIER };
    }
  }
  return undefined;
}

export async function launch(
  dest: Destination,
  product: ProductInfo,
  log: (message: string) => void
): Promise<void> {
  if (dest.group === "generic") {
    throw new Error("Pick a concrete device to run (not a generic destination).");
  }

  if (dest.group === "mac") {
    const killed = await run(
      "pkill",
      ["-f", `${product.appPath}/Contents/MacOS/`],
      OPTS
    )
      .then(() => true)
      .catch(() => false);
    if (killed) {
      await sleep(400);
    }
    await run("open", [product.appPath], OPTS);
    log(`▶ Launched ${basename(product.appPath)}`);
    return;
  }

  const udid = /id=([^,]+)/.exec(dest.value)?.[1];
  if (!udid) {
    throw new Error(`Could not determine device id from "${dest.value}".`);
  }

  if (dest.group === "simulator") {
    await launchOnSimulator(udid, dest, product, log);
    return;
  }

  log(`▶ Installing on ${dest.label}…`);
  await run(
    "xcrun",
    ["devicectl", "device", "install", "app", "--device", udid, product.appPath],
    OPTS
  );
  requireBundleId(product);
  await run(
    "xcrun",
    [
      "devicectl",
      "device",
      "process",
      "launch",
      "--terminate-existing",
      "--device",
      udid,
      product.bundleId!,
    ],
    OPTS
  );
  log(`▶ Launched ${product.bundleId} on ${dest.label}`);
}

async function launchOnSimulator(
  udid: string,
  dest: Destination,
  product: ProductInfo,
  log: (message: string) => void
): Promise<void> {
  log(`▶ Booting ${dest.label}…`);
  await run("xcrun", ["simctl", "boot", udid], OPTS).catch((err) => {
    const text = String(err?.stderr ?? err?.message ?? err);
    if (!/current state: Booted/.test(text)) {
      throw err;
    }
  });
  await run("open", ["-a", "Simulator"], OPTS).catch(() => {});
  await run("xcrun", ["simctl", "bootstatus", udid], OPTS);

  log("▶ Installing…");
  await run("xcrun", ["simctl", "install", udid, product.appPath], OPTS);

  requireBundleId(product);
  await run(
    "xcrun",
    ["simctl", "launch", "--terminate-running-process", udid, product.bundleId!],
    OPTS
  );
  log(`▶ Launched ${product.bundleId} on ${dest.label}`);
}

function requireBundleId(product: ProductInfo): void {
  if (!product.bundleId) {
    throw new Error("Missing PRODUCT_BUNDLE_IDENTIFIER; cannot launch the app.");
  }
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
