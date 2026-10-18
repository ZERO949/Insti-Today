// Compila el APK con Gradle y lo deja en ../dist/Insti-Today-Android.apk.
// Capacitor 8 compila con Java 21: se usa ~/Android/jdk-21 si existe; si no,
// JAVA_HOME. ANDROID_HOME, por defecto ~/Android/Sdk.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const android = path.join(aqui, 'android');
const windows = process.platform === 'win32';

const env = { ...process.env };
env.ANDROID_HOME ||= path.join(os.homedir(), 'Android', 'Sdk');
const jdk21 = path.join(os.homedir(), 'Android', 'jdk-21');
if (fs.existsSync(jdk21)) env.JAVA_HOME = jdk21;
if (!fs.existsSync(path.join(android, 'local.properties'))) {
  fs.writeFileSync(path.join(android, 'local.properties'), `sdk.dir=${env.ANDROID_HOME.replace(/\\/g, '/').replace(':', '\\:')}\n`);
}

const r = spawnSync(windows ? '.\\gradlew.bat' : './gradlew', ['assembleDebug', '--console=plain'], { cwd: android, env, stdio: 'inherit', shell: windows });
if (r.status !== 0) process.exit(r.status || 1);

const destino = path.join(aqui, '..', 'dist', 'Insti-Today-Android.apk');
fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.copyFileSync(path.join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'), destino);
console.log(`APK listo: ${destino}`);
