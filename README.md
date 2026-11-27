# agent-headunit

Agent Headunit brings Agent Device’s snapshots, selectors, and controls to the live Android Auto screen in Open Headunit.

Frida reads accessibility nodes from the Android processes that draw the car screen. Agent Headunit combines their windows into one snapshot, maps each control’s bounds to car screen coordinates, and checks the ref against the visible control before tapping.

## Windows quick start

From your Android project, use your existing `agent-device` installation. Setup also needs [Python 3.12 for Windows x64](https://www.python.org/downloads/release/python-31210/) with the Python launcher.

```powershell
npm install -g https://github.com/zappybiby/agent-headunit/releases/download/v0.0.1/agent-headunit-0.0.1.tgz
agent-headunit setup --phone-avd AA_Phone --receiver-avd AA_Receiver
```

Use your AVD names. Setup registers the provider and downloads Frida and the Open Headunit APK. If an Agent Device daemon is running, finish its sessions and run `agent-device daemon stop` once to load the provider.

<details>
<summary>First time? Create the phone and receiver in Android Studio</summary>

1. Install [Android Studio](https://developer.android.com/studio) with the standard SDK. In **Device Manager**, create two Pixel AVDs with Android 16 (API 36) x86_64 images. Use **Google Play** for `AA_Phone` and **Google APIs** for `AA_Receiver`. Start only the phone.
2. Extract [rootAVD](https://github.com/galihlasahido/rootAVD/archive/96ebe08618249d585fb551e0fcbdd27b361c8bf4.zip). In the folder containing `rootAVD.bat`, run these commands.

   ```powershell
   $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
   $env:Path = "$env:ANDROID_HOME\platform-tools;$env:Path"
   Copy-Item .\Magisk30.zip .\Magisk.zip -Force
   .\rootAVD.bat system-images\android-36\google_apis_playstore\x86_64\ramdisk.img FAKEBOOTIMG
   ```

3. Follow the Magisk prompts, then **Cold Boot** the phone from Device Manager. Run `adb shell "su -c 'id -u'"` and grant **Shell** root access. Look for `0`.
4. On the phone, sign in to Google Play and install or update Android Auto. Search Settings for **Android Auto**, expand **Version**, and tap **Version and permission info** ten times. Enable developer mode.
5. Start the receiver. Drag `%LOCALAPPDATA%\agent-headunit\open-headunit.apk` from Explorer onto its emulator window. Open the app and select **Headunit Server** as its wireless mode.

</details>

On the phone, open Android Auto settings and select **⋮ → Start head unit server** after each reboot. From your project, connect and accept the phone’s first connection prompts.

```powershell
$env:AGENT_DEVICE_SESSION = "car"
agent-device connect headunit --platform android
agent-device open com.google.android.projection.gearhead
agent-device snapshot
```

## Source

[`provider/`](provider/) connects Agent Device commands to the [Android backend](backend/). [`windows/`](windows/) handles setup, [`scripts/`](scripts/) builds the package, and [`tests/`](tests/) covers both runtimes. CI installs [Agent Device](https://github.com/callstack/agent-device) from npm and checks new releases daily.
