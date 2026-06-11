import { ChildProcess, spawn } from "child_process";
import * as vscode from "vscode";
import { CommandSpec } from "./platform";

export interface RunOptions {
  outputFilter?: string;
  /** When to reveal the output panel: never, only on failure, or always. */
  reveal: "never" | "onError" | "always";
}

export interface BuildResult {
  /** Process exit code, or null if it was killed. */
  code: number | null;
  /** True when the command exited 0 (and, if a failure marker was given, it was not seen). */
  succeeded: boolean;
  /** True when the build was stopped by the user. */
  cancelled: boolean;
}

/**
 * Owns the build child process (xcodebuild or gradlew). The output channel is
 * shared with the controller (so the run/launch steps log to the same place).
 * Only one build runs at a time; the controller gates that, but we guard here too.
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

  async run(spec: CommandSpec, opts: RunOptions): Promise<BuildResult> {
    if (this.child) {
      throw new Error("A build is already running.");
    }
    this.cancelled = false;

    this.output.clear();
    if (opts.reveal === "always") {
      this.output.show(true);
    }
    this.output.appendLine(`▶ ${spec.title}`);
    this.output.appendLine(
      `$ ${spec.command} ${spec.args.map(quote).join(" ")}`
    );

    let filter: RegExp | undefined;
    if (opts.outputFilter && opts.outputFilter.trim()) {
      try {
        filter = new RegExp(opts.outputFilter);
      } catch (err) {
        this.output.appendLine(
          `⚠️  Ignoring invalid nativeBuilds.outputFilter: ${String(err)}`
        );
      }
    }

    let sawFailed = false;

    return new Promise<BuildResult>((resolve) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
      });
      this.child = child;

      const handleChunk = (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (spec.failureMarker && line.includes(spec.failureMarker)) {
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
        this.output.appendLine(
          `❌ Failed to launch ${spec.command}: ${err.message}`
        );
        this.child = undefined;
        resolve({ code: null, succeeded: false, cancelled: this.cancelled });
      });

      child.on("close", (code) => {
        this.child = undefined;
        const cancelled = this.cancelled;
        // -quiet suppresses the success banner, so trust the exit code.
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
        if (!succeeded && !cancelled && opts.reveal === "onError") {
          this.output.show(true);
        }
        resolve({ code, succeeded, cancelled });
      });
    });
  }
}

function quote(arg: string): string {
  return /[\s'"]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg;
}
