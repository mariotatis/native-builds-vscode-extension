import { ChildProcess, spawn } from "child_process";
import * as vscode from "vscode";
import { CommandSpec } from "./platform";

export interface RunOptions {
  outputFilter?: string;
  reveal: "never" | "onError" | "always";
  parsePhase?: (line: string) => string | undefined;
  onPhase?: (phase: string | undefined) => void;
}

export interface BuildResult {
  code: number | null;
  succeeded: boolean;
  cancelled: boolean;
}

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
    let phase: string | undefined;
    opts.onPhase?.(undefined);

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
          if (line === "") {
            continue;
          }
          if (opts.parsePhase) {
            const next = opts.parsePhase(line);
            if (next && next !== phase) {
              phase = next;
              opts.onPhase?.(phase);
            }
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
