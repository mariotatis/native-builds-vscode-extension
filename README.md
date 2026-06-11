# Apple Build

Build and run **iOS / iPadOS / macOS** Xcode projects straight from the VS Code
status bar — no Xcode window required.

Open a folder with an `.xcodeproj` or `.xcworkspace` and the status bar gets a
scheme picker, a device picker, a **Build** button (with a **⌄** dropdown for
`build` / `clean build` / `clean`), and a **Run** button that builds, installs,
and launches on the selected destination — `open` for macOS, `xcrun simctl` for
simulators, `xcrun devicectl` for connected devices.

While a build/run is in progress the active button shows a spinner and a **Stop**
button appears. Clicking **Build** or **Run** again cancels the in-flight one and
starts fresh.

## Settings

Edit in **Settings** (`Cmd+,` → search "Apple Build") or `settings.json`. The
build action (Build / Clean Build) is chosen from the status bar dropdown, not here.

| Setting | Default | Description |
| --- | --- | --- |
| `appleBuild.quiet` | `true` | Pass `-quiet` to xcodebuild — only warnings, errors, and the final result. |
| `appleBuild.revealOutput` | `onError` | When to auto-open the output panel: `never`, `onError`, or `always`. |
| `appleBuild.outputFilter` | `""` | Regex; only matching output lines are shown (e.g. `error:\|warning:\|BUILD SUCCEEDED\|BUILD FAILED`). |
| `appleBuild.additionalBuildArgs` | `[]` | Extra args appended to every invocation (e.g. `["-configuration", "Debug", "CODE_SIGNING_ALLOWED=NO"]`). |
| `appleBuild.includeAllSimulators` | `false` | Also list watchOS / tvOS / visionOS simulators. |

## Requirements

macOS with **Xcode** and command-line tools (`xcodebuild`, `xcrun` on `PATH`).
