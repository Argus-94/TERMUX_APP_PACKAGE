#!/usr/bin/env python3
"""Compile and exercise generated candidate evidence staging on a JVM host; no Android/device or ARM64 execution."""
from pathlib import Path
import hashlib, json, os, shutil, subprocess
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'verification-v494/candidate-jvm'; OUT.mkdir(parents=True,exist_ok=True)
ASSETS=ROOT/'assets/termux-candidate-probe'
GEN=ROOT/'plugins/candidateFeedProbe.js'
# Obtain the exact production-generated Kotlin via its requested package export.
node="const f=require(process.argv[1]); process.stdout.write(f.candidateProbeKotlin('com.karat.aibuilder'));"
r=subprocess.run(['node','-e',node,str(GEN)],text=True,capture_output=True,check=True)
source=OUT/'AibCandidateFeedProbe.kt'; source.write_text(r.stdout)
assets={p.relative_to(ASSETS).as_posix():p.read_bytes() for p in ASSETS.rglob('*') if p.is_file()}
assert len(assets)==9, f'expected nine retained assets, got {len(assets)}'
for rel,b in assets.items():
 encoded=rel+'.aibasset' if rel.endswith('.gz') else rel
 (OUT/'assets'/encoded).parent.mkdir(parents=True,exist_ok=True); (OUT/'assets'/encoded).write_bytes(b)
(OUT/'HostHarness.kt').write_text(r'''package host
import android.content.Context
import com.karat.aibuilder.AibCandidateFeedProbe
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
fun check(b:Boolean,m:String){if(!b) error(m)}
fun denied(label:String, ctx:Context, msg:String?=null){var t:Throwable?=null;try{AibCandidateFeedProbe.stage(ctx)}catch(e:Throwable){t=e};check(t!=null,"$label accepted");if(msg!=null)check(t!!.message==msg,"$label wrong denial: ${t!!.message}")}
fun main(){
 val base=File(System.getProperty("harness.root")); val assets=File(System.getProperty("harness.assets"))
 fun fresh(tag:String):Pair<Context,File>{val f=Files.createTempDirectory(base.toPath(),"fixture-$tag-").toFile();File(f,"usr").mkdir();File(f,"home").mkdir();return Context(f,assets) to f}
 val (c,f)=fresh("success"); val beforeUsr=File(f,"usr").list()!!.toList();val beforeHome=File(f,"home").list()!!.toList()
 val root=File(AibCandidateFeedProbe.stage(c));check(root.isDirectory && root.parentFile==File(f,"candidate-probes"),"returned root not under private evidence parent")
 val actual=root.walkTopDown().filter{it.isFile}.map{it.relativeTo(root).invariantSeparatorsPath}.toSet()
 val expected=assets.walkTopDown().filter{it.isFile}.map{it.relativeTo(assets).invariantSeparatorsPath}.toSet().map{val logical=if(it.endsWith(".aibasset"))it.removeSuffix(".aibasset") else it;if(logical=="probe.sh"||logical=="install-make.sh") logical else "feed/"+logical}.toSet()
 check(actual==expected && actual.size==9,"staged asset set differs: $actual")
 for(rel in expected){val original=rel.removePrefix("feed/");val stored=if(original.endsWith(".gz"))original+".aibasset" else original;val a=File(root,rel).readBytes();val b=File(assets,stored).readBytes();check(a.contentEquals(b),"bytes mismatch $rel")}
 check(File(root,"install-make.sh").isFile && !File(root,"feed/install-make.sh").exists(),"install-make.sh placement incorrect")
 check(File(f,"usr").list()!!.toList()==beforeUsr && File(f,"home").list()!!.toList()==beforeHome,"usr/home mutated")
 println("PASS successful stage: exact 9 pinned assets/hashbytes, UUID child root, install-make.sh at root; usr/home unchanged")
 val (badApp,fa)=fresh("app");badApp.packageName="no.app";denied("wrong package",badApp,"candidate_package_invalid");check(!File(fa,"candidate-probes").exists(),"wrong package copied")
 val (badAbi,fb)=fresh("abi");android.os.Build.SUPPORTED_ABIS=arrayOf("x86_64");denied("wrong ABI",badAbi,"candidate_arch_invalid");check(!File(fb,"candidate-probes").exists(),"wrong ABI copied");android.os.Build.SUPPORTED_ABIS=arrayOf("arm64-v8a")
 println("PASS wrong package/ABI rejected before evidence copies")
 val (noUsr,fu)=fresh("nousr");File(fu,"usr").delete();denied("missing usr",noUsr);check(!File(fu,"candidate-probes").exists(),"missing usr created evidence parent")
 val (noHome,fh)=fresh("nohome");File(fh,"home").delete();denied("missing home",noHome);check(!File(fh,"candidate-probes").exists(),"missing home created evidence parent")
 val (sy,fs)=fresh("symlink");File(fs,"usr").delete();Files.createSymbolicLink(File(fs,"usr").toPath(),File(fs,"home").toPath());denied("usr symlink",sy)
 val (fileCtx,ff)=fresh("file");File(ff,"usr").delete();File(ff,"usr").writeText("not dir");denied("usr file",fileCtx)
 val (foreign,fo)=fresh("foreign");android.system.Os.foreignPath=File(fo,"usr").path;denied("foreign owner",foreign,"candidate_directory_owner_invalid");android.system.Os.foreignPath=""
 println("PASS missing usr/home, symlink/file parent and foreign-owner checks fail closed")
 val (corrupt,fc)=fresh("corrupt");corrupt.assetOverride="probe.sh";denied("corrupt asset",corrupt);check(File(fc,"candidate-probes").isDirectory,"expected partial evidence parent absent")
 val (oversize,fx)=fresh("oversize");oversize.assetOverride="oversize:probe.sh";denied("oversized asset",oversize);check(File(fx,"candidate-probes").isDirectory,"oversize partial evidence parent absent")
 println("PASS corrupted hash and oversized asset rejected")
 val (limit,fl)=fresh("limit");val parent=File(fl,"candidate-probes").apply{mkdir()};repeat(10){File(parent,"seed-$it").mkdir()};denied("10-item limit",limit,"candidate_evidence_limit");check(parent.list()!!.size==10,"limit changed existing entries")
 println("PASS exact ten-entry evidence limit")
 val (repeatCtx,fr)=fresh("repeat");val roots=(1..3).map{File(AibCandidateFeedProbe.stage(repeatCtx))};check(roots.map{it.name}.toSet().size==3 && roots.all{it.isDirectory},"repeated staging not fresh")
 println("PASS repeated calls create distinct fresh evidence roots")
 val (concurrent,fn)=fresh("concurrent");val pool=Executors.newFixedThreadPool(6);val latch=CountDownLatch(1);val futures=(1..6).map{pool.submit<String>{latch.await();AibCandidateFeedProbe.stage(concurrent)}};latch.countDown();val paths=futures.map{it.get()};pool.shutdown();check(paths.toSet().size==6 && paths.all{File(it).isDirectory},"concurrent calls collided")
 check(File(fn,"usr").isDirectory&&File(fn,"home").isDirectory,"concurrent call altered usr/home");println("PASS synchronized concurrent staging creates six distinct roots")
 base.listFiles()?.filter{it.isDirectory&&it.name.startsWith("fixture-")}?.forEach{it.deleteRecursively()}
 println("PASS JVM host runtime evidence only; no Android instrumentation/device test or ARM64 execution")
}
''')
stubs={
'android/content/Context.kt':'''package android.content
import java.io.File
class Context(val filesDir:File,val assetRoot:File){var packageName="com.karat.aibuilder";var assetOverride:String="";val assets=AssetManager(this)}
class AssetManager(private val c:Context){fun open(s:String):java.io.InputStream{val rel=s.substringAfter("candidate-probe/");val stored=if(rel.endsWith(".gz"))rel+".aibasset" else rel;if(c.assetOverride==rel)return java.io.ByteArrayInputStream("changed".toByteArray());if(c.assetOverride=="oversize:$rel")return object:java.io.InputStream(){var n=0;override fun read():Int=if(n++<6000)65 else -1;override fun read(b:ByteArray,o:Int,l:Int):Int{if(n>=6000)return -1;val x=minOf(l,6000-n);java.util.Arrays.fill(b,o,o+x,65.toByte());n+=x;return x}};return java.io.File(c.assetRoot,stored).inputStream()}}
''',
'android/os/Build.kt':'package android.os\nobject Build { @JvmField var SUPPORTED_ABIS=arrayOf("arm64-v8a") }\n',
'android/os/Process.kt':'''package android.os
object Process { @JvmStatic fun myUid()=System.getProperty("harness.uid")?.toInt() ?: 1000 }
''',
'android/system/OsConstants.kt':'package android.system\nobject OsConstants { const val S_IFMT=0xF000; const val S_IFDIR=0x4000; const val S_IFLNK=0xA000; const val S_IFREG=0x8000 }\n',
'android/system/Os.kt':'''package android.system
import java.nio.file.*
object Os {var foreignPath="";class Stat(val st_mode:Int,val st_uid:Int)
 @JvmStatic fun lstat(s:String):Stat {val p=Paths.get(s);val a=Files.readAttributes(p,"unix:mode,uid",LinkOption.NOFOLLOW_LINKS) as Map<*,*>;val mode=(a["mode"] as Number).toInt();val uid=(a["uid"] as Number).toInt();return Stat(mode,if(s==foreignPath)uid+1 else uid)}
}
'''}
for n,t in stubs.items(): p=OUT/'stubs'/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(t)
cache=Path(os.environ.get('GRADLE_USER_HOME', str(Path.home()/'.gradle'))).expanduser()/'caches/modules-2/files-2.1'
def jar(g,a,v):return str(next((cache/g/a/v).glob('*/*.jar')))
compiler=jar('org.jetbrains.kotlin','kotlin-compiler-embeddable','2.1.20');stdlib=jar('org.jetbrains.kotlin','kotlin-stdlib','2.1.20');cor=jar('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm','1.8.0');ann=str(next((cache/'org.jetbrains/annotations').glob('*/*/*.jar')));trove=str(next((cache/'org.jetbrains.intellij.deps/trove4j').glob('*/*/*.jar')))
cp=':'.join([compiler,stdlib,cor,ann,trove]);classes=OUT/'classes';shutil.rmtree(classes,ignore_errors=True);classes.mkdir()
files=[str(source),str(OUT/'HostHarness.kt')]+[str(p) for p in sorted((OUT/'stubs').rglob('*.kt'))]
cmd=['java','-cp',cp,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-classpath',':'.join([stdlib,ann]),'-d',str(classes),*files]
(OUT/'compile.command.json').write_text(json.dumps(cmd,indent=2)+'\n')
with (OUT/'compile.log').open('w') as log:subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT,check=True)
run=['java','-Dharness.root='+str(OUT),'-Dharness.assets='+str(OUT/'assets'),'-Dharness.uid='+str(os.getuid()),'-cp',':'.join([str(classes),stdlib]),'host.HostHarnessKt']
with (OUT/'run.log').open('w') as log:subprocess.run(run,stdout=log,stderr=subprocess.STDOUT,check=True)
print((OUT/'run.log').read_text(),end='')
shutil.rmtree(classes)
