# aib-native-accel (MIT)

Open optional accelerator for AI Builder userspace (plan Phase G).

## What it is

- Pure C path-map helper (`aib_map_path`)
- Optional JNI (`AibAccelNative`)
- React Native module **`AibNativeAccel`** injected by `plugins/withAibNativeAccel.js`

## What it is NOT

- Not DSHA `libproroot.so`
- Not required for product features
- Router falls back to termux-native / proot-distro when probe fails

## Build

Expo prebuild + config plugin copies sources and registers the RN package.
Kotlin module works even if `.so` is not linked (pure JVM path map).
