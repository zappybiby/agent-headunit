# agent-headunit

Agent Headunit brings Agent Device’s snapshots, selectors, and controls to the live Android Auto screen in Open Headunit.

Frida reads Android’s accessibility nodes from the processes that draw the car screen. Agent Headunit combines the projected windows into one snapshot and maps each control’s bounds to car screen coordinates. Before a tap, it checks that the ref still points to the same visible control.

## Windows quick start

1. Install [Android Studio](https://developer.android.com/studio) with the standard Android SDK, [Node.js 24](https://nodejs.org/en/download), and [Python 3.12 for Windows x64](https://www.python.org/downloads/release/python-31210/) with the Python launcher. Extract the [Windows release ZIP](https://github.com/zappybiby/agent-headunit/releases/latest/download/agent-headunit-windows-x64.zip). Run setup in that folder.

   ```powershell
   py -3.12 setup.py
   ```

2. In Android Studio’s **Device Manager**, create two Pixel AVDs with these names and x86_64 images. Start only `AA_Phone`.

   | AVD | Android 16 (API 36) image |
   | --- | --- |
   | `AA_Phone` | Google Play |
   | `AA_Receiver` | Google APIs |

3. Extract [rootAVD](https://github.com/galihlasahido/rootAVD/archive/96ebe08618249d585fb551e0fcbdd27b361c8bf4.zip). Run these commands in the folder containing `rootAVD.bat`.

   ```powershell
   $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
   $env:Path = "$env:ANDROID_HOME\platform-tools;$env:Path"
   Copy-Item .\Magisk30.zip .\Magisk.zip -Force
   .\rootAVD.bat system-images\android-36\google_apis_playstore\x86_64\ramdisk.img FAKEBOOTIMG
   ```

   Follow the Magisk prompts. **Cold Boot** the phone from Device Manager, run `adb shell su -c "id -u"`, and grant **Shell** root access. The command should print `0`.

4. On the phone, sign in to Google Play and install or update Android Auto. Search Settings for **Android Auto**, expand **Version**, and tap **Version and permission info** ten times. Confirm developer mode and select **⋮ → Start head unit server**. Repeat that last step after a phone reboot.

5. Start `AA_Receiver`. Drag `open-headunit.apk` from the release folder onto its emulator window. Open the app, finish setup, and select **Headunit Server** as its wireless mode.

6. In the release folder, connect and open Android Auto. Accept the phone’s first connection prompts, then take a snapshot.

   ```powershell
   .\agent-headunit.cmd connect headunit --platform android
   .\agent-headunit.cmd open com.google.android.projection.gearhead
   .\agent-headunit.cmd snapshot
   ```
