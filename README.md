# agent-headunit

Agent Headunit brings Agent Device’s snapshots, selectors, and controls to the live Android Auto screen in Open Headunit.

Frida reads accessibility nodes from the Android processes that draw the car screen. Agent Headunit combines their windows into one snapshot, maps each control’s bounds to car screen coordinates, and checks the ref against the visible control before tapping.

## Windows quick start

Use PowerShell on Windows x64.

### Install the tools

- **Node.js and Java.** Reuse Node.js 22.12+ and JDK 21. For missing tools, run `winget install -e --id OpenJS.NodeJS.LTS` for Node or `winget install -e --id Microsoft.OpenJDK.21` for Java. Reopen PowerShell after installation.
- **Python.** Run `py -0p`. Reuse 64-bit Python 3.13 or 3.12. If you need Python, get the [Python install manager](https://www.python.org/downloads/windows/) and run `pymanager install 3.13`.
- **Android SDK.** Use the current SDK command line tools. If you need them, get the Windows ZIP under [Command line tools only](https://developer.android.com/studio#command-tools). Extract its inner `cmdline-tools` folder as `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest` so `latest\bin\android.exe` exists.

Run the remaining commands in one PowerShell window. For future sessions, keep the SDK's `platform-tools` and `emulator` folders on your PATH.

```powershell
if (!$env:ANDROID_HOME) { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
$env:Path = "$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator;$env:Path"
$env:HEADUNIT_PYTHON = py -3.13 -c "import sys; print(sys.executable)"  # Use -3.12 for Python 3.12
```

### Install Agent Headunit

Install the [latest release](https://github.com/zappybiby/agent-headunit/releases/latest). If Agent Device is missing, these commands read the tested version from the release and install it from npm.

```powershell
$release = Invoke-RestMethod https://api.github.com/repos/zappybiby/agent-headunit/releases/latest
$asset = $release.assets | Where-Object name -Like 'agent-headunit-*.tgz'
$package = Join-Path $env:TEMP $asset.name
Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $package -ErrorAction Stop
if (!(Get-Command agent-device.cmd -ErrorAction SilentlyContinue)) {
    $version = (tar.exe -xOf $package package/package.json | ConvertFrom-Json).devDependencies.'agent-device'
    npm.cmd install -g "agent-device@$version"
}
npm.cmd install -g $package
```

Setup registers the provider, installs Frida, and downloads the matching phone server and Open Headunit APK. For an existing rooted x86_64 phone and a configured receiver, substitute their AVD names below and skip to [Connect](#connect).

```powershell
agent-headunit.cmd setup --phone-avd AA_Phone --receiver-avd AA_Receiver
```

### Create the emulators

With other emulators closed, choose a platform with Google Play (phone) and Google APIs (receiver) images. Android 17 is the example. Projected touch supports phone API levels 36 and 37.

```powershell
android "--sdk=$env:ANDROID_HOME" sdk list --all 'system-images/*/google_apis*/x86_64'
$platform = 'android-37.0'  # Use the platform from your chosen image
$phoneImage = "system-images;$platform;google_apis_playstore;x86_64"
$receiverImage = "system-images;$platform;google_apis;x86_64"
foreach ($id in 'platform-tools','emulator',$phoneImage,$receiverImage) {
    android "--sdk=$env:ANDROID_HOME" sdk install ($id.Replace(';','/'))
    if ($LASTEXITCODE) { throw "Could not install $id" }
}
'no' | avdmanager.bat create avd -n AA_Phone -k $phoneImage -d pixel_6
'no' | avdmanager.bat create avd -n AA_Receiver -k $receiverImage -d pixel_6
Start-Process emulator -ArgumentList '-avd AA_Phone -port 5554'
```

If the emulator reports missing acceleration, enable [Windows Hypervisor Platform](https://developer.android.com/studio/run/emulator-acceleration#vm-windows) and restart Windows.

### Root the phone

Extract [rootAVD](https://github.com/galihlasahido/rootAVD) (**Code → Download ZIP**) and `cd` into the folder containing `rootAVD.bat`. Once the phone shows its home screen, patch its SDK ramdisk. Other AVDs using that phone image share the patch.

```powershell
$env:ANDROID_SERIAL = 'emulator-5554'
$magisk = switch (adb shell getprop ro.build.version.sdk) {
    '36' { 'Magisk30.zip' }
    '37' { 'Magisk31.zip' }
    default { throw 'Check the rootAVD compatibility chart for this Android version.' }
}
Copy-Item $magisk Magisk.zip -Force
.\rootAVD.bat "$($phoneImage.Replace(';','\'))\ramdisk.img" FAKEBOOTIMG
Remove-Item Env:ANDROID_SERIAL
```

In Magisk, choose **Install → Select and Patch a File → Download/fakeboot.img**. Follow rootAVD's prompts. When the phone shuts down, cold boot it.

```powershell
Start-Process emulator -ArgumentList '-avd AA_Phone -port 5554 -no-snapshot-load'
```

At the home screen, run `adb -s emulator-5554 shell "su -c 'id -u'"`. Grant **Shell** root access. PowerShell should print `0`.

### Set up Android Auto

On the phone, sign in to Google Play and install or update **Android Auto**. Open its settings and start the receiver.

```powershell
adb -s emulator-5554 shell am start -a com.google.android.projection.gearhead.SETTINGS
Start-Process emulator -ArgumentList '-avd AA_Receiver -port 5556'
```

In Android Auto settings, tap **Version**, then **Version and permission info** ten times. Choose **OK → ⋮ → Start head unit server**. At the receiver's home screen, install and open the APK.

```powershell
adb -s emulator-5556 install -r "$env:LOCALAPPDATA\agent-headunit\open-headunit.apk"
adb -s emulator-5556 shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p com.andrerinas.headunitrevived
```

In Open Headunit, finish the prompts and set **Wireless Mode** to **Headunit Server**.

### Connect

Start the phone's head unit server again after each reboot. From your Android project, run the commands below and accept the phone's connection prompts. The snapshot should list car screen controls with refs such as `@e2`.

```powershell
$env:AGENT_DEVICE_SESSION = 'car'
agent-device.cmd connect headunit --platform android
agent-device.cmd open com.google.android.projection.gearhead
agent-device.cmd snapshot
```

## Source

[`provider/`](provider/) connects Agent Device commands to the [Android backend](backend/). [`windows/`](windows/) handles setup, [`scripts/`](scripts/) builds the package, and [`tests/`](tests/) covers both runtimes. CI installs [Agent Device](https://github.com/callstack/agent-device) from npm and checks new releases daily.
