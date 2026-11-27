# agent-headunit

Agent Headunit brings Agent Device’s snapshots, selectors, and controls to the live Android Auto screen in Open Headunit.

Frida reads accessibility nodes from the Android processes that draw the car screen. Agent Headunit combines their windows into one snapshot, maps each control’s bounds to car screen coordinates, and checks the ref against the visible control before tapping.

## Windows quick start

1. **Install the Windows tools.** On a Windows 11 x64 PC, run these commands in PowerShell.

   ```powershell
   winget install -e --id Google.AndroidStudio
   winget install -e --id OpenJS.NodeJS.24
   winget install -e --id Python.Python.3.12
   ```

2. **Install Agent Device and Agent Headunit.** Open a new PowerShell window and run these commands from any folder.

   ```powershell
   $package = "$env:TEMP\agent-headunit-0.0.1.tgz"
   curl.exe -fL https://github.com/zappybiby/agent-headunit/releases/download/v0.0.1/agent-headunit-0.0.1.tgz -o $package
   npm.cmd install -g agent-device@0.21.44 $package
   agent-headunit.cmd setup
   ```

   Setup installs Frida on the PC and downloads the matching Android server and Open Headunit APK. The provider starts Frida on the phone automatically.

3. **Create two emulators.** Open Android Studio, finish the **Standard** setup wizard, then choose **More Actions → Virtual Device Manager** on the welcome screen. Create two Pixel virtual devices with these exact names. Download the images when prompted.

   | Device name | Android 16 (API 36) x86_64 image |
   | --- | --- |
   | `AA_Phone` | Google Play |
   | `AA_Receiver` | Google APIs |

   If Android Studio requests hardware acceleration, enable [Windows Hypervisor Platform](https://developer.android.com/studio/run/emulator-acceleration#vm-windows) and restart Windows. Start only `AA_Phone` and wait for its home screen.

4. **Root the phone.** Download and extract [rootAVD](https://github.com/galihlasahido/rootAVD/archive/96ebe08618249d585fb551e0fcbdd27b361c8bf4.zip). Open PowerShell in the folder containing `rootAVD.bat`.

   ```powershell
   $env:Path = "$env:LOCALAPPDATA\Android\Sdk\platform-tools;$env:Path"
   Copy-Item .\Magisk30.zip .\Magisk.zip -Force
   .\rootAVD.bat system-images\android-36\google_apis_playstore\x86_64\ramdisk.img FAKEBOOTIMG
   ```

   Follow the Magisk prompts. When the phone shuts down, choose **Cold Boot** for `AA_Phone` in Device Manager. At the home screen, run `adb shell "su -c 'id -u'"` in the same PowerShell window. Grant **Shell** root access on the phone. PowerShell should print `0`.

5. **Start Android Auto and install Open Headunit.**

   - **On the phone.** Sign in to Google Play and install or update **Android Auto**. Search Android Settings for **Android Auto**. Tap **Version**, tap **Version and permission info** ten times, then **OK → ⋮ → Start head unit server**. Start the server again after each phone reboot.
   - **On the receiver.** Start `AA_Receiver`. In File Explorer, open `%LOCALAPPDATA%\agent-headunit` and drag `open-headunit.apk` onto the receiver window. Open the installed app, finish its prompts, and set **Wireless Mode** to **Headunit Server**.

6. **Take a snapshot.** Run these commands in PowerShell. Accept the phone’s connection prompts when `open` runs.

   ```powershell
   $env:AGENT_DEVICE_SESSION = "car"
   agent-device.cmd connect headunit --platform android
   agent-device.cmd open com.google.android.projection.gearhead
   agent-device.cmd snapshot
   ```

   The snapshot lists controls from the car screen with refs such as `@e2`.

## Source

[`provider/`](provider/) connects Agent Device commands to the [Android backend](backend/). [`windows/`](windows/) handles setup, [`scripts/`](scripts/) builds the package, and [`tests/`](tests/) covers both runtimes. CI installs [Agent Device](https://github.com/callstack/agent-device) from npm and checks new releases daily.
