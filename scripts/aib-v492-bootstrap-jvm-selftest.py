#!/usr/bin/env python3
"""Compile the generated Android bootstrap installer against tiny host stubs and exercise real ZIP/filesystem behavior."""
from pathlib import Path
import json, subprocess, hashlib, shutil, os, sys
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'verification-v492/bootstrap-jvm'; OUT.mkdir(parents=True,exist_ok=True)
ASSET=ROOT/'assets/termux-bootstrap/termux-bootstrap-aarch64.zip'
prov=json.loads(Path(str(ASSET)+'.provenance.json').read_text())
sha=hashlib.sha256(ASSET.read_bytes()).hexdigest()
assert sha==prov['archiveSha256']
source=OUT/'AibEmbeddedTermuxBootstrapInstaller.kt'
meta=json.dumps(prov,separators=(',',':'))
node="""const f=require(process.argv[1]); const p=JSON.parse(process.argv[2]); process.stdout.write(f('com.karat.aibuilder',p));"""
r=subprocess.run(['node','-e',node,str(ROOT/'plugins/termuxBootstrapInstallerKotlin.js'),meta],text=True,capture_output=True,check=True)
source.write_text(r.stdout)
(OUT/'bootstrap.zip').write_bytes(ASSET.read_bytes())
(OUT/'provenance.json').write_text(json.dumps(prov))
(OUT/'BootstrapHostHarness.kt').write_text(r'''package host
import android.content.Context
import java.io.File
import java.lang.reflect.InvocationTargetException
import org.json.JSONObject
import java.nio.file.Files
import com.karat.aibuilder.AibEmbeddedTermuxBootstrapInstaller

fun call(o: Any, name:String, types:Array<Class<*>>, args:Array<Any?>):Any? {
 val m=o.javaClass.getDeclaredMethod(name,*types); m.isAccessible=true
 try { return m.invoke(o,*args) } catch(e:InvocationTargetException) { throw (e.targetException ?: e) }
}
fun checkThat(b:Boolean, s:String) { if(!b) error(s) }
fun main() {
 val root=File(System.getProperty("harness.root")); val zip=File(root,"bootstrap.zip")
 val installer=Class.forName("com.karat.aibuilder.AibEmbeddedTermuxBootstrapInstaller").getField("INSTANCE").get(null)
 fun fresh(label:String):Pair<Context,File> { val base=Files.createTempDirectory(root.toPath(), "aib-v492-$label-").toFile(); val files=File(base,"files").apply{mkdirs()}; val ctx=Context(files,File(base,"cache")); ctx.cacheDir.mkdirs(); return ctx to files }
 val (c,f)=fresh("extract"); val stage=File(f,"usr.installing"); val prefix=File(f,"usr")
 var extraction:Throwable?=null
 try { call(installer,"extractBootstrap", arrayOf(File::class.java,File::class.java,File::class.java), arrayOf(zip,stage,prefix)) } catch(t:Throwable) { extraction=t }
 if(extraction!=null) {
   val msg=extraction!!.message ?: ""
   checkThat(msg=="symlink_target_outside_private_prefix", "unexpected extraction failure: ${extraction!!.javaClass.name}: $msg")
   error("EXPECTED_FIX_NOT_PRESENT: real archive extraction rejected: $msg")
 }
 checkThat(File(stage,"bin/bash").canExecute(),"real bootstrap bash not executable after extraction")
 checkThat(File(stage,"bin/apt").exists() && File(stage,"etc/termux/termux-bootstrap/second-stage/termux-bootstrap-second-stage.sh").isFile,"real bootstrap required paths absent")
 println("PASS real archive extracted to private staging with links and executable bits")
 // Activate the exact real extracted prefix: no host execution of ARM64 binaries.
 val c2=c; val f2=f; val p2=prefix; Files.move(stage.toPath(),p2.toPath())
 val home=File(f2,"home").apply{mkdirs()}; File(home,"keep.txt").writeText("home remains")
 val marker=JSONObject(File(root,"provenance.json").readText())
 val mf=File(f2,"termux-bootstrap.json")
 val valid=JSONObject().put("schemaVersion",1).put("applicationId",c2.packageName).put("architecture","aarch64").put("androidAbi","arm64-v8a").put("installState","complete").put("secondStageCompleted",true).put("prefixRelativePath","usr").put("homeRelativePath","home").put("archiveSha256",marker.getString("archiveSha256")).put("sourceCommit",marker.getString("sourceCommit")).put("bootstrapVersion",marker.getString("bootstrapVersion"))
 mf.writeText(valid.toString())
 val lockFile=File(p2,"etc/termux/termux-bootstrap/second-stage/termux-bootstrap-second-stage.sh.lock")
 Files.createSymbolicLink(lockFile.toPath(), java.nio.file.Paths.get("termux-bootstrap-second-stage.sh"))
 fun isComplete()=call(installer,"isCompleteInstall",arrayOf(Context::class.java,File::class.java,File::class.java,File::class.java),arrayOf(c2,p2,home,mf)) as Boolean
 checkThat(isComplete(),"real complete install fixture rejected")
 mf.writeText("{}")
 checkThat(!isComplete(),"corrupt manifest accepted")
 mf.writeText(valid.toString())
 File(p2,"var/lib/dpkg/status").delete()
 checkThat(!isComplete(),"partial dpkg state accepted")
 call(installer,"quarantineDamagedManagedPrefix",arrayOf(Context::class.java,File::class.java,File::class.java),arrayOf(c2,p2,mf))
 val quarantined=f2.listFiles()!!.filter{it.name.startsWith("usr.recovery-")}
 checkThat(!p2.exists() && quarantined.size==1 && File(quarantined[0],"bin/bash").isFile,"managed damage not quarantined")
 checkThat(File(home,"keep.txt").readText()=="home remains","home changed during repair")
 call(installer,"extractBootstrap",arrayOf(File::class.java,File::class.java,File::class.java),arrayOf(zip,stage,prefix))
 checkThat(File(stage,"bin/dpkg").isFile,"retry fresh extraction failed")
 println("PASS complete exact payload, corrupt manifest rejection, partial dpkg detection, managed quarantine and retry preserving home")
 // Exercise both API launch branches and dynamic execution environment without executing Android binaries.
 android.os.Build.VERSION.SDK_INT=33
 val launch=AibEmbeddedTermuxBootstrapInstaller.shellCommand(stage,"-c","printf ok")
 checkThat(launch==listOf("/system/bin/linker64",File(stage,"bin/bash").absolutePath,"-c","printf ok"),"API33 command/argv mismatch")
 val env=AibEmbeddedTermuxBootstrapInstaller.executionEnvironment(c2,stage,home,c2.cacheDir)
 checkThat(env["LD_PRELOAD"]==File(stage,"lib/libtermux-exec-linker-ld-preload.so").absolutePath && env["TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE"]=="force","API33 preload mode missing")
 checkThat(env["TERMUX__USER_ID"]=="0" && env["TERMUX__PREFIX"]==stage.absolutePath,"UID/prefix environment incorrect")
 android.os.Build.VERSION.SDK_INT=28
 checkThat(AibEmbeddedTermuxBootstrapInstaller.shellCommand(stage,"-l").first()==File(stage,"bin/bash").absolutePath,"API28 launch mismatch")
 checkThat(AibEmbeddedTermuxBootstrapInstaller.executionEnvironment(c2,stage,home,c2.cacheDir)["LD_PRELOAD"]!!.endsWith("libtermux-exec-direct-ld-preload.so"),"API28 preload mismatch")
 android.os.Build.VERSION.SDK_INT=33
 println("PASS API28/API33 launch argv and dynamic environment, no ARM64 execution claimed")
 val (c3,f3)=fresh("recovery"); val p3=File(f3,"usr"); val st3=File(f3,"usr.installing"); val h3=File(f3,"home"); h3.mkdirs(); File(p3,"sentinel").apply{parentFile.mkdirs();writeText("partial")}; File(st3,"partial").apply{parentFile.mkdirs();writeText("partial")}
 val shaConst=installer.javaClass.getDeclaredField("EXPECTED_ARCHIVE_SHA256").apply{isAccessible=true}.get(null) as String
 val pend=File(f3,".termux-bootstrap-installing.json"); pend.writeText(JSONObject().put("schemaVersion",1).put("applicationId",c3.packageName).put("archiveSha256",shaConst).put("installState","pending").toString())
 call(installer,"recoverInterruptedInstall",arrayOf(Context::class.java,File::class.java,File::class.java,File::class.java),arrayOf(c3,p3,st3,pend))
 checkThat(!p3.exists()&&!st3.exists()&&!pend.exists()&&h3.isDirectory,"valid interrupted-install recovery failed/preserved-home violation")
 println("PASS recoverInterruptedInstall clears only pending prefix/stage and preserves home")
 val (c4,f4)=fresh("unmanaged"); val unmanaged=File(f4,"usr").apply{mkdirs();File(this,"sentinel").writeText("keep")}; val hm=File(f4,"home").apply{mkdirs()}
 // Fail closed is the guard in installBlocking immediately after valid recovery; invoke installBlocking and ensure unmanaged data remains.
 val denied=call(installer,"installBlocking",arrayOf(Context::class.java),arrayOf(c4))!!
 val deniedStatus=denied.javaClass.getDeclaredField("status").apply{isAccessible=true}.get(denied)
 checkThat(deniedStatus=="existing_prefix_unmanaged","unmanaged prefix unexpectedly accepted: $deniedStatus")
 checkThat(File(unmanaged,"sentinel").readText()=="keep","unmanaged prefix modified")
 println("PASS unmanaged prefix fails closed without modification")
 // Invalid pending metadata must not grant permission to remove an unmanaged prefix.
 val badPending=File(f4,".termux-bootstrap-installing.json").apply{writeText("{broken")}
 call(installer,"recoverInterruptedInstall",arrayOf(Context::class.java,File::class.java,File::class.java,File::class.java),arrayOf(c4,unmanaged,File(f4,"usr.installing"),badPending))
 checkThat(File(unmanaged,"sentinel").readText()=="keep","corrupt pending marker authorized deletion")
 println("PASS corrupt pending marker preserves unmanaged prefix")
 // Full fresh native install attempt reaches Android-only process startup on host,
 // rolls back, then repeats using the same app data (restart/retry fixture).
 val (c5,f5)=fresh("native-install-retry")
 repeat(2) { attempt ->
   val done=java.util.concurrent.CountDownLatch(1)
   var outcome:AibEmbeddedTermuxBootstrapInstaller.Outcome?=null
   AibEmbeddedTermuxBootstrapInstaller.installIfNeeded(c5) { result -> outcome=result; done.countDown() }
   checkThat(done.await(120,java.util.concurrent.TimeUnit.SECONDS),"native installer callback timeout")
   checkThat(outcome?.ready==false && outcome?.status=="second_stage_start_failed" && outcome?.detail=="IOException","unexpected host full install outcome: $outcome")
   checkThat(!File(f5,"usr").exists() && !File(f5,"usr.installing").exists() && !File(f5,".termux-bootstrap-installing.json").exists(),"failed install not rolled back on attempt $attempt")
   checkThat(File(f5,"home").isDirectory,"home not preserved after failed install")
 }
 println("PASS full fresh installer API reaches host Android-exec failure, rolls back and retries; no Android success claimed")
 root.listFiles()?.filter { it.isDirectory && it.name.startsWith("aib-v492-") }?.forEach{ it.deleteRecursively() }

}
''')
stubs={
'android/content/Context.kt':'''package android.content
import java.io.File
import android.content.res.AssetManager
import android.content.pm.ApplicationInfo
open class Context(val filesDir:File,val cacheDir:File) { val packageName="com.karat.aibuilder"; val applicationContext get()=this; val assets=AssetManager(); val applicationInfo=ApplicationInfo().apply{dataDir=filesDir.parentFile.absolutePath} }
''',
'android/content/res/AssetManager.kt':'package android.content.res\nclass AssetManager { fun open(s:String):java.io.InputStream=java.io.File(System.getProperty("harness.assets"),s.substringAfterLast("/")).inputStream() }\n',
'android/content/pm/ApplicationInfo.kt':'package android.content.pm\nclass ApplicationInfo { var dataDir:String="" }\n',
'android/os/Build.kt':'package android.os\nobject Build { @JvmField val SUPPORTED_ABIS=arrayOf("arm64-v8a"); object VERSION { @JvmField var SDK_INT=33 } }\n',
'android/os/Handler.kt':'package android.os\nclass Handler(x:Looper) { fun post(r:Runnable):Boolean {r.run();return true} }\n',
'android/os/Looper.kt':'package android.os\nclass Looper { companion object { @JvmStatic fun getMainLooper()=Looper() } }\n',
'android/os/Process.kt':'package android.os\nobject Process { @JvmStatic fun myUid()=10000 }\n',
'android/os/StatFs.kt':'package android.os\nclass StatFs(s:String) { val availableBytes=Long.MAX_VALUE }\n',
'android/util/Log.kt':'package android.util\nobject Log { @JvmField var lastError:Throwable?=null; @JvmStatic fun e(t:String,m:String,e:Throwable?=null):Int {lastError=e;return 0}; @JvmStatic fun w(t:String,m:String,e:Throwable?=null)=0 }\n',
'android/system/ErrnoException.kt':'package android.system\nclass ErrnoException(msg:String,val errno:Int):Exception(msg)\n',
'android/system/OsConstants.kt':'package android.system\nobject OsConstants { const val ENOENT=2; const val S_IFMT=0xF000; const val S_IFDIR=0x4000; const val S_IFLNK=0xA000; const val S_IFREG=0x8000 }\n',
'android/system/Os.kt':'''package android.system
import java.io.File
import java.nio.file.*
import java.nio.file.attribute.BasicFileAttributes
object Os { class Stat(val st_mode:Int)
 @JvmStatic fun lstat(s:String):Stat { try { val p=Paths.get(s); val a=Files.readAttributes(p,BasicFileAttributes::class.java,LinkOption.NOFOLLOW_LINKS); return Stat(when {a.isSymbolicLink->OsConstants.S_IFLNK;a.isDirectory->OsConstants.S_IFDIR;else->OsConstants.S_IFREG}) } catch(e:NoSuchFileException){throw ErrnoException("lstat",OsConstants.ENOENT)} }
 @JvmStatic fun chmod(s:String,mode:Int) { val p=Paths.get(s); val perms=Files.getPosixFilePermissions(p); if(mode and 64 != 0) perms.add(java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE); Files.setPosixFilePermissions(p,perms) }
 @JvmStatic fun rename(a:String,b:String) { Files.move(Paths.get(a),Paths.get(b),StandardCopyOption.REPLACE_EXISTING) }
 @JvmStatic fun symlink(target:String,path:String) { Files.createSymbolicLink(Paths.get(path),Paths.get(target)) }
 @JvmStatic fun remove(s:String) { Files.delete(Paths.get(s)) }
 @JvmStatic fun rmdir(s:String) { Files.delete(Paths.get(s)) }
}
'''}
for name,text in stubs.items():
	p=OUT/'stubs'/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(text)
cache=Path(os.environ.get('GRADLE_USER_HOME', str(Path.home()/'.gradle'))).expanduser()/'caches/modules-2/files-2.1'
def jar(g,a,v): return str(next((cache/g/a/v).glob('*/*.jar')))
compiler=jar('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20'); stdlib=jar('org.jetbrains.kotlin','kotlin-stdlib','2.1.20'); cor=jar('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0'); ann=str(next((cache/'org.jetbrains/annotations').glob('*/*/*.jar'))); trove=str(next((cache/'org.jetbrains.intellij.deps/trove4j').glob('*/*/*.jar')))
cp=':'.join([compiler,stdlib,cor,ann,trove]); classes=OUT/'classes'; shutil.rmtree(classes,ignore_errors=True); classes.mkdir()
jsonjar=jar('org.json','json','20180813')
files=[str(source),str(OUT/'BootstrapHostHarness.kt')]+[str(p) for p in sorted((OUT/'stubs').rglob('*.kt'))]
cmd=['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',':'.join([stdlib,ann,jsonjar]),'-d',str(classes),*files]
(OUT/'compile.command.json').write_text(json.dumps(cmd,indent=2)+'\n')
with (OUT/'compile.log').open('w') as log: subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT,check=True)
run=['java','-Dharness.root='+str(OUT),'-Dharness.assets='+str(ASSET.parent),'-cp',':'.join([str(classes),stdlib,jsonjar]),'host.BootstrapHostHarnessKt']
with (OUT/'run.log').open('w') as log: subprocess.run(run,stdout=log,stderr=subprocess.STDOUT,check=True)
print((OUT/'run.log').read_text(),end='')
