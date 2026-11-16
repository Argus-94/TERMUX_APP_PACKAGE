#!/usr/bin/env python3
"""Compile exact generated production Kotlin and exercise host filesystem models; no Android/ARM execution."""
import hashlib
import json
import os
import atexit
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'verification-v494/full-feed-native'
CACHE = Path(os.environ.get('GRADLE_USER_HOME', str(Path.home() / '.gradle'))).expanduser() / 'caches/modules-2/files-2.1'


def jar(group, artifact, version='*'):
    return str(next((CACHE / group / artifact).glob(version + '/*/*.jar')))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    android_assets = OUT / 'android-assets'
    shutil.rmtree(android_assets, ignore_errors=True)
    for source_asset in (ROOT / 'assets/termux-candidate-full').rglob('*'):
        if source_asset.is_file():
            rel = source_asset.relative_to(ROOT / 'assets/termux-candidate-full').as_posix()
            encoded = rel + '.aibasset' if rel.endswith('.gz') else rel
            target = android_assets / encoded
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source_asset.read_bytes())
    host_root = Path(tempfile.mkdtemp(prefix='aib-v493-full-jvm-', dir=str(Path(tempfile.gettempdir()).resolve()))).resolve()
    atexit.register(shutil.rmtree, host_root, ignore_errors=True)
    host_user_app = host_root / 'data/user/0/com.karat.aibuilder'
    host_data_app = host_root / 'data/data/com.karat.aibuilder'
    host_user_app.mkdir(parents=True)
    host_data_app.parent.mkdir(parents=True)
    host_data_app.symlink_to(host_user_app, target_is_directory=True)
    host_data_files = str(host_data_app / 'files')
    host_user_files = str(host_user_app / 'files')
    generated = subprocess.check_output(['node', '-e', "process.stdout.write(require(process.argv[1]).candidateFullKotlin('com.karat.aibuilder',process.argv[2]))", str(ROOT / 'plugins/candidateFullFeed.js'), str(ROOT)], text=True)
    for android_path, host_path in [('/data/data/com.karat.aibuilder/files', host_data_files), ('/data/user/0/com.karat.aibuilder/files', host_user_files)]:
        if android_path not in generated:
            raise RuntimeError('expected Android filesDir root missing from generated Kotlin: ' + android_path)
        generated = generated.replace(android_path, host_path)
    source = OUT / 'AibCandidateFullFeed.kt'
    source.write_text(generated)
    stubs = {
        'android/content/Context.kt': '''package android.content
import java.io.File
class Context(val filesDir:File,val assetRoot:File){var packageName="com.karat.aibuilder"; var corrupt=false;val assets=AssetManager(this)}
class AssetManager(private val c:Context){fun open(name:String):java.io.InputStream{require(name.startsWith("candidate-full/"));val rel=name.removePrefix("candidate-full/");val stored=if(rel.endsWith(".gz"))rel+".aibasset" else rel;val f=File(c.assetRoot,stored);if(c.corrupt){val b=f.readBytes();b[0]=(b[0].toInt() xor 1).toByte();return b.inputStream()};return f.inputStream()}}
''',
        'android/os/Process.kt': 'package android.os\nobject Process { @JvmStatic fun myUid()=' + str(os.getuid()) + ' }\n',
        'android/os/Build.kt': 'package android.os\nobject Build { @JvmField var SUPPORTED_ABIS=arrayOf("arm64-v8a") }\n',
        'android/system/OsConstants.kt': 'package android.system\nobject OsConstants { const val S_IFMT=0xF000; const val S_IFDIR=0x4000; const val S_IFREG=0x8000; const val O_RDONLY=0 }\n',
        'android/system/Os.kt': '''package android.system
import java.nio.file.*
class ErrnoException:Exception()
object Os { class Stat(val st_mode:Int,val st_uid:Int)
 @JvmStatic fun lstat(s:String):Stat {try{val a=Files.readAttributes(Paths.get(s),"unix:mode,uid",LinkOption.NOFOLLOW_LINKS) as Map<*,*>;return Stat((a["mode"] as Number).toInt(),(a["uid"] as Number).toInt())}catch(e:NoSuchFileException){throw ErrnoException()}}
 @JvmStatic fun open(s:String,flags:Int,mode:Int)=java.io.FileDescriptor()
 @JvmStatic fun fsync(fd:java.io.FileDescriptor) {}
 @JvmStatic fun close(fd:java.io.FileDescriptor) {}
}
''',
        'org/json/JSONArray.kt': '''package org.json
class JSONObject(private val raw:String){
 private fun value(key:String):String{val marker="\\\""+key+"\\\"";val start=raw.indexOf(marker);check(start>=0){"missing JSON key"};val colon=raw.indexOf(':',start+marker.length);check(colon>=0){"missing JSON value"};val tail=raw.substring(colon+1).trimStart();val end=tail.indexOfAny(charArrayOf(',', '}'));return (if(end>=0)tail.substring(0,end) else tail).trim()}
 fun getString(key:String)=value(key).removeSurrounding("\\\"")
 fun getLong(key:String)=value(key).toLong()
}
class JSONArray(private val raw:String){private val rows=Regex("""\\{[^{}]*\\}""").findAll(raw).map{it.value}.toList();fun length()=rows.size;fun getJSONObject(i:Int)=JSONObject(rows[i])}
'''
    }
    shutil.rmtree(OUT / 'stubs', ignore_errors=True)
    for rel, content in stubs.items():
        path = OUT / 'stubs' / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    (OUT / 'HostHarness.kt').write_text('''package host
import android.content.Context
import com.karat.aibuilder.AibCandidateFullFeed
import java.io.File
import java.nio.file.Files
fun check(b:Boolean,m:String){if(!b) error(m)}
fun rejects(label:String,block:()->Unit){var bad=false;try{block()}catch(e:Throwable){bad=true};check(bad,label);println("PASS reject "+label)}
fun main(){
 val base=File(System.getProperty("harness.root"));val assets=File(System.getProperty("harness.assets"))
 fun context(name:String):Context{val f=File(base,"data/data/com.karat.aibuilder/files");f.deleteRecursively();check(f.mkdirs(),"files");check(f.absolutePath!=f.canonicalPath,"Android data/data alias was not modeled");check(File(f,"usr").mkdir(),"usr");check(File(f,"home").mkdir(),"home");return Context(f,assets)}
 val ctx=context("normal"); val root=File(AibCandidateFullFeed.stage(ctx))
 val files=root.walkTopDown().filter{it.isFile}.map{it.relativeTo(root).invariantSeparatorsPath}.toSet();check(files.size==92,"92 files")
 val before=files.associateWith{File(root,it).length() to File(root,it).lastModified()}
 check(AibCandidateFullFeed.stage(ctx)==root.canonicalPath,"stable repeat path")
 check(before.all{(r,p)->(File(root,r).length() to File(root,r).lastModified())==p},"repeat rewrote cache")
 check(File(ctx.filesDir,"usr").list()!!.isEmpty()&&File(ctx.filesDir,"home").list()!!.isEmpty(),"usr/home mutated")
 println("PASS exact 92 pinned files, stable hash-revalidation, unchanged usr/home")
 val extra=File(root,"extra");extra.writeText("x");rejects("extra file"){AibCandidateFullFeed.stage(ctx)};check(extra.delete(),"remove extra")
 val extraDir=File(root,"extra-directory");check(extraDir.mkdir(),"extra dir");rejects("extra directory"){AibCandidateFullFeed.stage(ctx)};check(extraDir.delete(),"remove extra dir")
 val target=File(root,"packages.tsv");val original=target.readBytes();target.appendText("x");rejects("corrupt cached bytes"){AibCandidateFullFeed.stage(ctx)};target.writeBytes(original)
 val saved=File(root,"packages.saved");check(target.renameTo(saved),"save target");Files.createSymbolicLink(target.toPath(),saved.toPath());rejects("cached symlink"){AibCandidateFullFeed.stage(ctx)};Files.delete(target.toPath());check(saved.renameTo(target),"restore target")
 val wrong=context("wrong-package");wrong.packageName="wrong.package";rejects("foreign application"){AibCandidateFullFeed.stage(wrong)}
 val abi=context("wrong-abi");android.os.Build.SUPPORTED_ABIS=arrayOf("x86_64");rejects("foreign ABI"){AibCandidateFullFeed.stage(abi)};android.os.Build.SUPPORTED_ABIS=arrayOf("arm64-v8a")
 val redirect=context("redirect");check(File(redirect.filesDir,"usr").delete(),"remove empty usr");Files.createSymbolicLink(File(redirect.filesDir,"usr").toPath(),File(redirect.filesDir,"home").toPath());rejects("redirected usr"){AibCandidateFullFeed.stage(redirect)}
 val damaged=context("damaged-asset");damaged.corrupt=true;rejects("corrupt packaged asset"){AibCandidateFullFeed.stage(damaged)};check(!File(damaged.filesDir,AibCandidateFullFeed.CACHE_NAME).exists(),"partial promoted")
 val partial=context("partial-limit");for(i in 1..3)check(File(partial.filesDir,".candidate-feed-stage-"+i).mkdir(),"partial mkdir");rejects("bounded partial retention"){AibCandidateFullFeed.stage(partial)}
 println("PASS host filesystem model only; Android Os fsync/ownership and ARM execution remain unqualified")
}
''')
    compiler = jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.1.20')
    stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', '2.1.20')
    annotations = jar('org.jetbrains', 'annotations')
    compiler_cp = ':'.join([compiler, stdlib, annotations, jar('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0'), jar('org.jetbrains.intellij.deps', 'trove4j')])
    runtime_cp = ':'.join([stdlib, annotations])
    classes = OUT / 'classes'
    shutil.rmtree(classes, ignore_errors=True)
    classes.mkdir()
    command = ['java', '-cp', compiler_cp, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-classpath', runtime_cp, '-d', str(classes), str(source), str(OUT / 'HostHarness.kt'), *[str(p) for p in sorted((OUT / 'stubs').rglob('*.kt'))]]
    (OUT / 'compile.command.json').write_text(json.dumps(command, indent=2) + '\n')
    with (OUT / 'compile.log').open('w') as log:
        subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    run = ['java', '-Dharness.root=' + str(host_root), '-Dharness.assets=' + str(android_assets), '-cp', str(classes) + ':' + runtime_cp, 'host.HostHarnessKt']
    with (OUT / 'run.log').open('w') as log:
        subprocess.run(run, stdout=log, stderr=subprocess.STDOUT, check=True)
    shutil.rmtree(classes)
    evidence = {'status': 'PASS', 'generatedKotlinSha256': hashlib.sha256(generated.encode()).hexdigest(), 'hostJvmOnly': True, 'androidExecution': 'NOT_RUN', 'arm64Execution': 'NOT_RUN', 'fsyncModeledByStub': True}
    (OUT / 'summary.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print((OUT / 'run.log').read_text(), end='')


if __name__ == '__main__':
    main()
