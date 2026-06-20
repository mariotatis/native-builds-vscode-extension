# Native Builds

Build and run **iOS / iPadOS / macOS** Xcode projects and **Android (Gradle /
Kotlin)** apps straight from the VS Code status bar — no Xcode window or Android
Studio required.

The status bar gets a scheme/variant picker, a device picker, a **Build** button
(with a **⌄** dropdown for `build` / `clean build` / `clean`), and a **Run**
button that builds, installs, and launches on the selected destination. While a
build/run is in progress the active button shows a spinner with the current
phase — e.g. `Running… Compiling…`, `Running… Installing…`, `Running… Launching…`
— and a **Stop** button appears. Clicking **Build** or **Run** again cancels the
in-flight one and starts fresh.

The toolchain is detected automatically per workspace. If both an Xcode project
and a Gradle project are present, the Xcode project takes precedence.

## Apple (Xcode)

Open a folder with an `.xcodeproj` or `.xcworkspace`. The picker lists the
project's **schemes** and a destination list of **My Mac**, connected devices,
and simulators. **Run** builds with `xcodebuild`, then launches with `open`
(macOS), `xcrun simctl` (simulators), or `xcrun devicectl` (connected devices).

The spinner reports the install/launch phases (`Booting…`, `Installing…`,
`Launching…`) always. The build phases (`Compiling…`, `Linking…`, `Signing…`)
require `nativeBuilds.quiet` to be `false`, since `-quiet` suppresses the
per-phase xcodebuild output they're read from.

## Android (Gradle / Kotlin)

Open a folder containing a Gradle wrapper (`gradlew`) and a module that applies
the `com.android.application` plugin. The picker lists the module's **build
variants** (e.g. `Debug`, `FreeRelease`) and a destination list of your **AVD
emulators** plus any running emulators / USB-connected devices (`adb devices`).

- **Build** runs `./gradlew :<module>:assemble<Variant>`; the **⌄** dropdown runs
  a one-off **Clean** (`gradlew clean`).
- **Run** assembles, boots the selected emulator (waiting for it to finish
  booting), installs the APK with `adb install`, and launches the app.

The spinner reports phases throughout — `Compiling…`, `Packaging…`,
`Assembling…` (read from Gradle's `> Task :…` output), then `Booting…`,
`Installing…`, `Launching…`. No extra configuration is needed; the phases show
under the default `--console=plain` output.

The Android SDK is located automatically from `nativeBuilds.androidSdkPath`, then
`ANDROID_HOME` / `ANDROID_SDK_ROOT`, then the platform default
(`~/Library/Android/sdk` on macOS) — the SDK does **not** need to be on your
`PATH`.

**Notes**

- **A JDK is required to run Gradle.** macOS ships only a `/usr/bin/java` *stub*
  that errors with "Unable to locate a Java Runtime" — that does not count. The
  extension auto-detects a real JDK (`JAVA_HOME` → **Android Studio's bundled
  JBR** → installed JVMs), so if Android Studio is installed it works without any
  setup. Otherwise install a JDK or set `nativeBuilds.javaHome`.
- The **variant** picker runs Gradle the first time you open the project, so it
  can take a few seconds to populate (cached afterwards; **Refresh** re-runs it).
- **Stop** cancels the in-flight Gradle build; a lingering Gradle daemon may keep
  running in the background, and it does not interrupt an emulator that is
  already booting.

## Settings

Edit in **Settings** (`Cmd+,` → search "Native Builds") or `settings.json`. Clean
and other build actions are run as a one-off from the status bar **⌄** dropdown
(the **Build** button always does a plain build), not configured here.

| Setting                             | Default   | Description                                                                                                                 |
|-------------------------------------|-----------|-----------------------------------------------------------------------------------------------------------------------------|
| `nativeBuilds.quiet`                | `true`    | Pass `-quiet` to xcodebuild — only warnings, errors, and the final result.                                                  |
| `nativeBuilds.revealOutput`         | `onError` | When to auto-open the output panel: `never`, `onError`, or `always`.                                                        |
| `nativeBuilds.outputFilter`         | `""`      | Regex; only matching output lines are shown (e.g. `error:\|warning:\|BUILD SUCCEEDED\|BUILD FAILED`).                       |
| `nativeBuilds.additionalBuildArgs`  | `[]`      | Extra args appended to every **xcodebuild** invocation (e.g. `["-configuration", "Debug", "CODE_SIGNING_ALLOWED=NO"]`).     |
| `nativeBuilds.includeAllSimulators` | `false`   | Also list watchOS / tvOS / visionOS simulators.                                                                             |
| `nativeBuilds.androidSdkPath`       | `""`      | Path to the Android SDK (containing `platform-tools` / `emulator`). Empty = auto-detect.                                    |
| `nativeBuilds.javaHome`             | `""`      | JDK home used to run Gradle (containing `bin/java`). Empty = auto-detect (JAVA_HOME → Android Studio JBR → installed JVMs). |
| `nativeBuilds.gradleArgs`           | `[]`      | Extra args appended to every **Gradle** invocation (e.g. `["--offline"]`).                                                  |

The `quiet` / `additionalBuildArgs` settings apply to Xcode; `gradleArgs` applies
to Android. `revealOutput` and `outputFilter` apply to both.

## Requirements

- **Apple:** macOS with **Xcode** and command-line tools (`xcodebuild`, `xcrun` on `PATH`).
- **Android:** the **Android SDK** (with `platform-tools` and `emulator`), a
  **JDK**, and a Gradle wrapper (`gradlew`) in the project. Both the SDK and the
  JDK are auto-detected (the JDK falls back to **Android Studio's bundled JBR**,
  e.g. `/Applications/Android Studio.app/Contents/jbr/Contents/Home`), so no
  `PATH` / `JAVA_HOME` setup is required if Android Studio is installed.

## Disclaimer

Native Builds is an independent, community-maintained extension. It is not
affiliated with, endorsed by, or sponsored by Apple Inc. or Google LLC. It
invokes the developer's own locally installed toolchain (Xcode, the Android SDK,
and Gradle). "Xcode", "iOS", "macOS", "iPadOS", "Android", "Kotlin", and related
names are trademarks of their respective owners and are used here only to
describe compatibility.

## Security

Native Builds executes only locally installed developer tools:

- xcodebuild
- xcrun
- gradlew
- adb
- emulator

The extension does not download code, execute remote scripts, collect user data, or communicate with external services.