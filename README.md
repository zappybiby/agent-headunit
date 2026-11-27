# agent-headunit

agent-headunit brings agent-device’s snapshots, selectors, and controls to the live Android Auto screen in Open Headunit.

Frida reads accessibility nodes from the Android processes that draw the car screen. agent-headunit combines their windows into one snapshot, maps each control’s bounds to car screen coordinates, and checks the ref against the visible control before tapping.

## Windows quick start

Use Windows x64 with Node.js 22.12+, stock agent-device, the Android SDK, and 64-bit Python 3.12–3.15. Keep `adb` and `emulator` on PATH. Setup finds an installed Python and keeps its dependencies in a private environment.

1. Download the `.tgz` from the [latest release](https://github.com/zappybiby/agent-headunit/releases/latest) into an empty folder. Open PowerShell there.
2. Install the provider and select your rooted phone and Open Headunit receiver from the installed AVDs. If you need to create them, follow [Create the emulators](#create-the-emulators) first.

   ```powershell
   npm.cmd install -g (Get-Item .\agent-headunit-*.tgz).FullName
   agent-headunit.cmd setup
   ```

   To script the selection, pass `--phone-avd NAME --receiver-avd NAME`. Setup remembers the pair on subsequent runs. If the receiver needs Open Headunit, start that AVD and add `--install-receiver`. For your own build, pass `--receiver-apk PATH`.

3. Start the phone's Android Auto head unit server. From your Android project, connect and accept the phone's prompts.

   ```powershell
   $env:AGENT_DEVICE_SESSION = 'car'
   agent-device.cmd connect headunit --platform android
   agent-device.cmd open com.google.android.projection.gearhead
   agent-device.cmd snapshot
   ```

### Create the emulators

<details>
<summary>Set up a Windows PC and an emulator pair from scratch</summary>

Install missing tools. For Node, run `winget install -e --id OpenJS.NodeJS.LTS`. For Java, run `winget install -e --id Microsoft.OpenJDK.21`. Reopen PowerShell and run `npm.cmd install -g agent-device`. For Python, use the [Python install manager](https://www.python.org/downloads/windows/) and run `pymanager install 3.14`.

Get the Windows ZIP under [Android SDK command line tools](https://developer.android.com/studio#command-tools). Extract the inner `cmdline-tools` folder as `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest`. If you already have an SDK elsewhere, set `ANDROID_HOME` to that SDK.

```powershell
if (!$env:ANDROID_HOME) { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
$env:Path = "$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator;$env:Path"
android "--sdk=$env:ANDROID_HOME" sdk list --all 'system-images/*/google_apis*/x86_64'
```

Choose a platform with Google Play and Google APIs images. Android 17 uses `android-37.0`. Projected touch supports phone API levels 36 and 37. These commands use two example AVD names.

```powershell
$platform = Read-Host 'SDK platform from the list'
$phone = 'AA_Phone'
$receiver = 'AA_Receiver'
$phoneImage = "system-images;$platform;google_apis_playstore;x86_64"
$receiverImage = "system-images;$platform;google_apis;x86_64"
foreach ($id in 'platform-tools','emulator',$phoneImage,$receiverImage) {
    android "--sdk=$env:ANDROID_HOME" sdk install ($id.Replace(';','/'))
    if ($LASTEXITCODE) { throw "Could not install $id" }
}
'no' | avdmanager.bat create avd -n $phone -k $phoneImage -d pixel_6
'no' | avdmanager.bat create avd -n $receiver -k $receiverImage -d pixel_6
Start-Process emulator -ArgumentList "-avd $phone"
```

If the emulator reports missing acceleration, enable [Windows Hypervisor Platform](https://developer.android.com/studio/run/emulator-acceleration#vm-windows) and restart Windows.

**Root the phone.** Run only the phone emulator for this step. Extract [rootAVD](https://github.com/galihlasahido/rootAVD) and `cd` into the folder containing `rootAVD.bat`. At the phone's home screen, select its Magisk archive and patch its ramdisk. Other AVDs using this phone image share the patch.

```powershell
$env:ANDROID_SERIAL = (adb -e get-serialno).Trim()
if ((adb emu avd name | Select-Object -First 1) -ne $phone) { throw 'Start only the selected phone AVD.' }
$magisk = switch (adb shell getprop ro.build.version.sdk) {
    '36' { 'Magisk30.zip' }
    '37' { 'Magisk31.zip' }
    default { throw 'Check the rootAVD compatibility chart for this Android version.' }
}
Copy-Item $magisk Magisk.zip -Force
.\rootAVD.bat "$($phoneImage.Replace(';','\'))\ramdisk.img" FAKEBOOTIMG
Remove-Item Env:ANDROID_SERIAL
```

In Magisk, choose **Install → Select and Patch a File → Download/fakeboot.img**. Follow rootAVD's prompts. After shutdown, run `Start-Process emulator -ArgumentList "-avd $phone -no-snapshot-load"`. At the home screen, run `adb -e shell "su -c 'id -u'"`, grant **Shell** root access, and check that it prints `0`.

**Start Android Auto.** On the phone, sign in to Google Play and install or update **Android Auto**. Open its settings with `adb -e shell am start -a com.google.android.projection.gearhead.SETTINGS`. Tap **Version**, then **Version and permission info** ten times. Choose **OK → ⋮ → Start head unit server**. Start the server again after each phone reboot.

**Prepare the receiver.** Run `Start-Process emulator -ArgumentList "-avd $receiver"`. At its home screen, return to quick start step 2 and run setup with `--install-receiver`. Open the installed app and choose **Wireless Mode → Headunit Server**, then continue to step 3.

</details>

## Source

[`provider/`](provider/) connects agent-device commands to the [Android backend](backend/). [`windows/`](windows/) handles setup, [`scripts/`](scripts/) builds the package, and [`tests/`](tests/) covers both runtimes. CI installs [agent-device](https://github.com/callstack/agent-device) from npm and checks new releases daily.
