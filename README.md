# agent-headunit

agent-headunit brings agent-device’s snapshots, selectors, and controls to the live Android Auto screen in Open Headunit.

Frida reads accessibility nodes from the Android processes that draw the car screen. agent-headunit combines their windows into one snapshot, maps each control’s bounds to car screen coordinates, and checks the ref against the visible control before tapping.

## Windows quick start

<details>
<summary><strong>Create the emulators</strong> · Windows x64, Android 17</summary>

1. **Install Node.js and Java.** Run in PowerShell as administrator, then restart Windows.

   ```powershell
   winget install -e --id OpenJS.NodeJS.LTS
   winget install -e --id Microsoft.OpenJDK.21
   Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
   ```

2. **Install Python and agent-device.** Install the [Python install manager](https://www.python.org/downloads/windows/), then use one regular PowerShell window for the remaining steps.

   ```powershell
   pymanager install 3.14
   npm.cmd install -g agent-device
   ```

3. **Install the Android SDK.** Download the [Windows command line tools](https://developer.android.com/studio#command-tools). Extract the contents of `cmdline-tools` into `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest`.

   ```powershell
   $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
   $env:Path = "$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator;$env:Path"
   android sdk install platform-tools
   android sdk install emulator
   android sdk install system-images/android-37.0/google_apis_playstore/x86_64
   android sdk install system-images/android-37.0/google_apis/x86_64
   ```

4. **Create both emulators. Start only the phone.**

   ```powershell
   'no' | avdmanager.bat create avd -n AA_Phone -k 'system-images;android-37.0;google_apis_playstore;x86_64' -d pixel_6
   'no' | avdmanager.bat create avd -n AA_Receiver -k 'system-images;android-37.0;google_apis;x86_64' -d pixel_6
   Start-Process emulator -ArgumentList '-avd AA_Phone'
   ```

5. **Root the phone.** Download and extract [rootAVD](https://github.com/galihlasahido/rootAVD). In PowerShell, enter the folder containing `rootAVD.bat`. Wait for the phone’s home screen.

   ```powershell
   $env:ANDROID_SERIAL = (adb -e get-serialno).Trim()
   Copy-Item .\Magisk31.zip .\Magisk.zip -Force
   .\rootAVD.bat system-images\android-37.0\google_apis_playstore\x86_64\ramdisk.img FAKEBOOTIMG
   Remove-Item Env:ANDROID_SERIAL
   ```

   In Magisk, choose **Install → Select and Patch a File → Download/fakeboot.img**. Follow the prompts until the phone shuts down.

6. **Cold boot the phone and verify root.**

   ```powershell
   Start-Process emulator -ArgumentList '-avd AA_Phone -no-snapshot-load'
   ```

   At the home screen, run `adb -e shell "su -c 'id -u'"`. Grant **Shell** root access and check for `0`.

7. **Enable Android Auto developer mode.** Sign in to Google Play on the phone, install or update **Android Auto**, then open its settings.

   ```powershell
   adb -e shell am start -a com.google.android.projection.gearhead.SETTINGS
   ```

   Tap **Version**, tap **Version and permission info** ten times, then tap **OK**.

8. **Start the receiver** and wait for its home screen.

   ```powershell
   Start-Process emulator -ArgumentList '-avd AA_Receiver'
   ```

</details>

### Connect to Android Auto

1. **Install agent-headunit.** With both emulators running, download the `.tgz` from the [latest release](https://github.com/zappybiby/agent-headunit/releases/latest) into an empty folder. Run these commands from that folder.

   ```powershell
   npm.cmd install -g (Get-Item .\agent-headunit-*.tgz).FullName
   agent-headunit.cmd setup --install-receiver
   ```

   Select the phone AVD when prompted.

2. **Start projection.**

   - **Phone** — Android Auto settings → **⋮ → Start head unit server**
   - **Receiver** — Open Headunit → **Wireless Mode → Headunit Server**

3. **Take a snapshot.** Run these commands from your Android project. Accept the phone’s connection prompts during `open`.

   ```powershell
   $env:AGENT_DEVICE_SESSION = 'car'
   agent-device.cmd connect headunit --platform android
   agent-device.cmd open com.google.android.projection.gearhead
   agent-device.cmd snapshot
   ```

## Source

| Working on | Start here |
| --- | --- |
| CLI and agent-device integration | [CLI commands](provider/cli/) · [Plugin registration](provider/index.mjs) · [Runtime](provider/runtime/) |
| Snapshots, refs, and coordinates | [Snapshot adapter](provider/projection/snapshot.mjs) · [Android accessibility tree](backend/accessibility/) · [Display geometry](backend/projection/displays.py) · [Frida scripts](backend/frida/) |
| Touch, scrolling, and typing | [Projection driver](provider/projection/) · [Android input](backend/controls/) |
| App launching and deep links | [Android Auto apps](backend/apps/) |
| Emulator connections and device controls | [Sessions](provider/session/) · [Emulator pair](backend/emulators/) · [Phone](provider/phone/) · [Receiver](provider/receiver/) |
| Installation and releases | [Windows setup](windows/) · [Package builder](scripts/install_provider.py) · [CI](.github/workflows/) |

[Tests](tests/) follow the same feature folders as the code they cover.
