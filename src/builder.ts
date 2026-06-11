import { ChildProcess, spawn } from "child_process";
import * as vscode from "vscode";
import { XcodeContainer } from "./xcode";

export interface BuildRequest {
  container: XcodeContainer;
  scheme: string;
  destination: string;
  action: string;
  extraArgs: string[];
  outputFilter?: string;
  quiet: boolean;
  /** When to reveal the output panel: never, only on failure, or always. */
  reveal: "never" | "onError" | "always";
}

export interface BuildResult {
  /** Process exit code, or null if it was killed. */
  code: number | null;
  /** True when xcodebuild reported BUILD SUCCEEDED and exited 0. */
  succeeded: boolean;
  /** True when the build was stopped by the user. */
  cancelled: boolean;
}

/**
 * Owns the xcodebuild child process. The output channel is shared with the
 * controller (so the run/launch steps can log to the same place). Only one
 * build runs at a time; the controller gates that, but we guard here too.
 */
export class Builder {
  private child: ChildProcess | undefined;
  private cancelled = false;

  constructor(private readonly output: vscode.OutputChannel) {}

  get isRunning(): boolean {
    return this.child !== undefined;
  }

  showOutput(): void {
    this.output.show(true);
  }

  log(message: string): void {
    this.output.appendLine(message);
  }

  dispose(): void {
    this.stop();
  }

  /** Send SIGINT to the running build, escalating to SIGKILL. */
  stop(): void {
    if (!this.child) {
      return;
    }
    this.cancelled = true;
    const proc = this.child;
    proc.kill("SIGINT");
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
    }, 4000);
  }

  async run(req: BuildRequest): Promise<BuildResult> {
    if (this.child) {
      throw new Error("A build is already running.");
    }
    this.cancelled = false;

    const args = buildArgs(req);
    this.output.clear();
    if (req.reveal === "always") {
      this.output.show(true);
    }
    this.output.appendLine(
      `▶ ${capitalize(req.action)} ${req.scheme} · ${req.destination}`
    );
    this.output.appendLine(`$ xcodebuild ${args.map(quote).join(" ")}`);

    let filter: RegExp | undefined;
    if (req.outputFilter && req.outputFilter.trim()) {
      try {
        filter = new RegExp(req.outputFilter);
      } catch (err) {
        this.output.appendLine(
          `⚠️  Ignoring invalid appleBuild.outputFilter: ${String(err)}`
        );
      }
    }

    let sawFailed = false;

    return new Promise<BuildResult>((resolve) => {
      const child = spawn("xcodebuild", args, {
        cwd: req.container.dir,
        env: process.env,
      });
      this.child = child;

      const handleChunk = (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (line.includes("BUILD FAILED")) {
            sawFailed = true;
          }
          // Skip the empty trailing line produced by splitting on "\n".
          if (line === "") {
            continue;
          }
          if (!filter || filter.test(line)) {
            this.output.appendLine(line);
          }
        }
      };

      child.stdout?.on("data", handleChunk);
      child.stderr?.on("data", handleChunk);

      child.on("error", (err) => {
        this.output.appendLine(`❌ Failed to launch xcodebuild: ${err.message}`);
        this.child = undefined;
        resolve({ code: null, succeeded: false, cancelled: this.cancelled });
      });

      child.on("close", (code) => {
        this.child = undefined;
        const cancelled = this.cancelled;
        // -quiet suppresses the "BUILD SUCCEEDED" banner, so trust the exit code.
        const succeeded = code === 0 && !sawFailed && !cancelled;
        if (cancelled) {
          this.output.appendLine("⏹  Stopped.");
        } else if (succeeded) {
          this.output.appendLine("✅ Build succeeded.");
        } else {
          this.output.appendLine(
            `❌ Build failed (exit code ${code ?? "killed"}).`
          );
        }
        if (!succeeded && !cancelled && req.reveal === "onError") {
          this.output.show(true);
        }
        resolve({ code, succeeded, cancelled });
      });
    });
  }
}

function buildArgs(req: BuildRequest): string[] {
  const flag = req.container.type === "workspace" ? "-workspace" : "-project";
  const args = [
    flag,
    req.container.fileName,
    "-scheme",
    req.scheme,
    "-destination",
    req.destination,
  ];
  if (req.quiet) {
    args.push("-quiet");
  }
  // action may be multi-word, e.g. "clean build".
  args.push(...req.action.split(/\s+/).filter(Boolean));
  args.push(...req.extraArgs);
  return args;
}

function quote(arg: string): string {
  return /[\s'"]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
