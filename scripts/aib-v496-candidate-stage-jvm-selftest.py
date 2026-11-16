#!/usr/bin/env python3
"""Compile and run the actual generated AibCandidateFullFeed.stage() on a host JVM with Android stubs."""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, tempfile
ROOT=Path(__file__).resolve().parent.parent
OUT=Path(tempfile.mkdtemp(prefix='aib-v496-candidate-stage-'))
GEN=ROOT/'plugins/candidateFullFeed.js'; ASSET=ROOT/'assets/termux-candidate-full'

def run(cmd, **kw): return subprocess.run(cmd, check=True, text=True, **kw)
try:
    js="const f=require(process.argv[1]); process.stdout.write(f.candidateFullKotlin('com.karat.aibuilder'));"
    generated=run(['node','-e',js,str(GEN)],capture_output=True).stdout
    # Keep the production Android allowlist intact; relocate its two exact roots only in this host-JVM copy.
    # This preserves canonical/symlink checks while avoiding privileged writes to the host's real /data tree.
    android_data_root=(OUT/'android-fixture'/'data'/'data').as_posix()
    android_user_root=(OUT/'android-fixture'/'data'/'user'/'0').as_posix()
    data_files=android_data_root+'/com.karat.aibuilder/files'
    user_files=android_user_root+'/com.karat.aibuilder/files'
    assert generated.count('/data/data/com.karat.aibuilder/files') >= 2, 'generated canonical app root not found'
    assert generated.count('/data/user/0/com.karat.aibuilder/files') >= 2, 'generated Android alias root not found'
    generated=generated.replace('/data/data/com.karat.aibuilder/files',data_files)
    generated=generated.replace('/data/user/0/com.karat.aibuilder/files',user_files)
    src=OUT/'AibCandidateFullFeed.kt'; src.write_text(generated)
    # Keep the real pinned payload available; root validation scenarios stop before any file copy.
    assets=OUT/'assets'/'candidate-full'; shutil.copytree(ASSET,assets)
    harness=r'''package host
import android.content.Context
import android.system.Os
import android.os.Build
import com.karat.aibuilder.AibCandidateFullFeed
import java.io.File
import java.nio.file.Files
fun check(b:Boolean,m:String){if(!b) error(m)}
fun denied(label:String,c:Context,expected:String){var e:Throwable?=null;try{AibCandidateFullFeed.stage(c)}catch(t:Throwable){e=t};check(e!=null,"$label unexpectedly accepted");check(e!!.message==expected,"$label: expected $expected, got ${e!!.message}");println("PASS $label denied (${e!!.message})")}
fun main(){
 val tmp=File(System.getProperty("harness.tmp")); val payload=File(System.getProperty("harness.assets"))
 val dataRoot=System.getProperty("harness.android.data"); val userRoot=System.getProperty("harness.android.user")
 val prefix="$dataRoot/com.karat.aibuilder/files"; val alias=File(prefix)
 check(!alias.exists(),"refusing to touch existing test alias $prefix")
 check(alias.mkdirs(),"cannot create isolated fixture path $prefix"); val created=true
 try {
  fun prep(file:File=alias):Context { file.mkdirs(); File(file,"usr").mkdirs();File(file,"home").mkdirs();return Context(file,payload) }
  // Current canonical app root proceeds past root validation and reaches first pinned asset open.
  val valid=prep(); val err=try{AibCandidateFullFeed.stage(valid);null}catch(t:Throwable){t}
  check(err!=null && (err!!.message?.contains("candidate-full/")==true || err!!.message?.contains("No such file")==true || err!!.javaClass.name.contains("FileNotFound")),"approved root did not pass validation / missing pinned asset: ${err?.javaClass}: ${err?.message}")
  println("PASS relocated canonical app-root accepted; reached expected pinned-asset missing/open failure (not full successful staging)")
  val aliasPackage=File("$userRoot/com.karat.aibuilder")
  check(!Files.exists(aliasPackage.toPath(),java.nio.file.LinkOption.NOFOLLOW_LINKS),"refusing existing Android alias package fixture")
  aliasPackage.parentFile.mkdirs()
  Files.createSymbolicLink(aliasPackage.toPath(),alias.parentFile.toPath())
  try {
   val androidAlias=File(aliasPackage,"files")
   check(androidAlias.absolutePath!=androidAlias.canonicalPath,"alias scenario must exercise a real absolute/canonical difference")
   check(androidAlias.canonicalPath==prefix,"alias must resolve exactly to the approved app root")
   val aliasErr=try{AibCandidateFullFeed.stage(Context(androidAlias,payload));null}catch(t:Throwable){t}
   check(aliasErr!=null && aliasErr!!.javaClass.name.contains("FileNotFound"),"Android alias failed before pinned-asset access: ${aliasErr?.message}")
   println("PASS relocated Android user-data -> app-data symlink alias accepted until pinned-asset access")
  } finally { aliasPackage.delete() }

  val alien=File("$dataRoot/com.karat.aibuilder.neighbor/files"); check(!alien.exists(),"refusing existing neighbor fixture"); alien.mkdirs(); File(alien,"usr").mkdirs();File(alien,"home").mkdirs()
  val alienContext=Context(alien,payload); denied("neighbor package canonical root",alienContext,"candidate_full_filesdir_noncanonical"); alien.parentFile.deleteRecursively()
  val other=File("$userRoot/foreign.package/files"); check(!other.exists(),"refusing existing foreign fixture"); other.mkdirs();File(other,"usr").mkdirs();File(other,"home").mkdirs(); denied("foreign canonical root",Context(other,payload),"candidate_full_filesdir_noncanonical"); other.parentFile.deleteRecursively()
  val sym=File(alias,"usr");sym.deleteRecursively(); Files.createSymbolicLink(sym.toPath(),File(alias,"home").toPath())
  denied("usr symlink",valid,"candidate_full_directory_invalid")
  sym.delete();sym.mkdirs()
  val homeLink=File(alias,"home");homeLink.deleteRecursively();Files.createSymbolicLink(homeLink.toPath(),sym.toPath())
  denied("home symlink",valid,"candidate_full_directory_invalid")
  homeLink.delete();homeLink.mkdirs()
  Os.uidOverride=System.getProperty("harness.uid").toInt()+1
  denied("incorrect UID/account ownership",valid,"candidate_full_directory_invalid")
  Os.uidOverride=-1
  Build.SUPPORTED_ABIS=arrayOf("x86_64"); denied("wrong ABI",valid,"candidate_full_arch_invalid");Build.SUPPORTED_ABIS=arrayOf("arm64-v8a")
  val wrong=prep();wrong.packageName="com.other.app";denied("wrong package",wrong,"candidate_full_package_invalid")
 } finally { if(created) alias.deleteRecursively() }
 println("PASS host JVM/stub equivalent only; not Android instrumentation or device execution")
}
'''
    # Compile the actual native catch mapping too: assertions never reimplement its policy.
    bridge=(ROOT/'plugins/withTermuxBridge.js').read_text()
    begin=bridge.index('                val knownReasons = setOf(')
    end=bridge.index('                promise.reject(code, code)',begin)
    mapping='\nfun hostNativeCode(error:Exception, phase:String):String {\n'+bridge[begin:end]+'\nreturn code\n}\n'
    harness=harness.replace(' println("PASS host JVM/stub equivalent only; not Android instrumentation or device execution")', r''' check(hostNativeCode(IllegalStateException("candidate_full_filesdir_noncanonical"),"stage")=="AIB_FULL_CANDIDATE_STAGE_FILESDIR_NONCANONICAL","exact root reason lost")
 check(hostNativeCode(IllegalStateException("candidate_full_cache_hash_invalid:/private/TOKEN"),"stage")=="AIB_FULL_CANDIDATE_STAGE_CACHE_HASH_INVALID","fixed hash reason lost or path leaked")
 check(hostNativeCode(IllegalStateException("candidate_full_secret_token"),"stage")=="AIB_FULL_CANDIDATE_STAGE_NATIVE_FAILURE","unknown native text leaked")
 check(hostNativeCode(android.system.ErrnoException("/private/TOKEN",android.system.OsConstants.EACCES),"stage")=="AIB_FULL_CANDIDATE_STAGE_IO_ACCESS_DENIED","access denied reason lost")
 check(hostNativeCode(android.system.ErrnoException("/private/TOKEN",android.system.OsConstants.ENOSPC),"transaction")=="AIB_FULL_CANDIDATE_TRANSACTION_IO_NO_SPACE","no space reason lost")
 check(hostNativeCode(java.io.IOException("TOKEN /private/path"),"stage")=="AIB_FULL_CANDIDATE_STAGE_IO_FAILURE","arbitrary IO text leaked")
 println("PASS actual native exception mapping: known root/hash reasons, EACCES/ENOSPC, hostile messages redacted")
 println("PASS host JVM/stub equivalent only; not Android instrumentation or device execution")''')
    (OUT/'Host.kt').write_text(harness+mapping)
    stubs={
'android/content/Context.kt':'''package android.content
import java.io.File
class Context(val filesDir:File,val assetRoot:File){var packageName="com.karat.aibuilder";val assets=AssetManager(this)}
class AssetManager(private val c:Context){fun open(s:String):java.io.InputStream { val rel=s.removePrefix("candidate-full/"); val file=File(c.assetRoot,rel); if(!file.isFile) throw java.io.FileNotFoundException("pinned asset missing: $s");return file.inputStream() }}
''',
'android/os/Build.kt':'package android.os\nobject Build { @JvmField var SUPPORTED_ABIS=arrayOf("arm64-v8a") }\n',
'android/os/Process.kt':'''package android.os
object Process { @JvmStatic fun myUid()=System.getProperty("harness.uid")?.toInt() ?: 1000 }
''',
'android/system/OsConstants.kt':'package android.system\nobject OsConstants { const val S_IFMT=0xF000; const val S_IFDIR=0x4000; const val S_IFLNK=0xA000; const val S_IFREG=0x8000; const val O_RDONLY=0; const val EACCES=13; const val EPERM=1; const val ENOENT=2; const val ENOSPC=28; const val ELOOP=40; const val ENOTDIR=20; const val EROFS=30 }\n',
'android/system/Os.kt':'''package android.system
	import java.nio.file.*
	object Os { var uidOverride=-1; class Stat(val st_mode:Int,val st_uid:Int)
	 @JvmStatic fun lstat(s:String):Stat { val a=try{Files.readAttributes(Paths.get(s),"unix:mode,uid",LinkOption.NOFOLLOW_LINKS) as Map<*,*>}catch(e:java.nio.file.NoSuchFileException){throw ErrnoException(s)};val mode=(a["mode"] as Number).toInt();val uid=(a["uid"] as Number).toInt();return Stat(mode,if(uidOverride>=0)uidOverride else uid) }
	 @JvmStatic fun open(s:String,f:Int,m:Int)=s
	 @JvmStatic fun fsync(fd:String){}
	 @JvmStatic fun close(fd:String){}
	}
	class ErrnoException(s:String,val errno:Int=2):Exception(s)
	''',
	'org/json/JSONArray.kt':r'''package org.json
class JSONObject(private val s:String){
 private fun colon(key:String):Int { val marker="\""+key+"\""; val start=s.indexOf(marker); if(start<0) error("missing $key"); val at=s.indexOf(':',start+marker.length); if(at<0) error("missing $key"); return at }
 fun getString(key:String):String { val at=colon(key); val first=s.indexOf('"',at+1); val last=if(first<0)-1 else s.indexOf('"',first+1); if(first<0||last<0) error("missing $key"); return s.substring(first+1,last) }
 fun getLong(key:String):Long { val at=colon(key); return Regex("""\d+""").find(s.substring(at+1))?.value?.toLong() ?: error("missing $key") }
}
class JSONArray(private val s:String){ private val rows=Regex("""\{[^{}]*\}""").findAll(s).map{it.value}.toList(); fun length()=rows.size; fun getJSONObject(i:Int)=JSONObject(rows[i]) }
'''
}
    for name,text in stubs.items():
        p=OUT/'stubs'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
    gradle_home=Path(os.environ.get('GRADLE_USER_HOME', str(Path.home()/'.gradle'))).expanduser()
    home=gradle_home/'caches/modules-2/files-2.1'
    def one(pattern):
        found=list(home.glob(pattern));
        if not found: raise RuntimeError('missing compiler dependency: '+pattern)
        return str(found[0])
    compiler=one('org.jetbrains.kotlin/kotlin-compiler-embeddable/2.1.20/*/*.jar'); stdlib=one('org.jetbrains.kotlin/kotlin-stdlib/2.1.20/*/*.jar')
    deps=[compiler,stdlib]
    for pattern in ['org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm/*/*/*.jar','org.jetbrains/annotations/*/*/*.jar','org.jetbrains.intellij.deps/trove4j/*/*/*.jar']:
        found=list(home.glob(pattern)); deps.extend(map(str,found[:1]))
    cp=':'.join(deps); classes=OUT/'classes';classes.mkdir()
    sources=[src,OUT/'Host.kt',*sorted((OUT/'stubs').rglob('*.kt'))]
    command=['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',stdlib,'-d',str(classes),*map(str,sources)]
    run(command)
    run(['java','-Dharness.tmp='+str(OUT),'-Dharness.uid='+str(os.getuid()),'-Dharness.assets='+str(assets),'-Dharness.android.data='+android_data_root,'-Dharness.android.user='+android_user_root,'-cp',str(classes)+':'+stdlib,'host.HostKt'])
finally:
    shutil.rmtree(OUT,ignore_errors=True)
