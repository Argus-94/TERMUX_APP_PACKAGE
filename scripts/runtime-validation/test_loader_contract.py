#!/usr/bin/env python3
"""Host-only scope controls; NOT Android or candidate execution."""
import json, os, platform, subprocess, tempfile
from pathlib import Path
HELPER = '''
extern int pa_echo_canceller_get_capture_volume(void *);
extern void pa_echo_canceller_set_capture_volume(void *, unsigned);
int exercise(void) {
 pa_echo_canceller_set_capture_volume(0,42);
 return pa_echo_canceller_get_capture_volume(0);
}
'''
PROVIDER = '''
static unsigned volume;
int pa_echo_canceller_get_capture_volume(void *p) {(void)p;return volume;}
void pa_echo_canceller_set_capture_volume(void *p,unsigned v) {(void)p;volume=v;}
'''
PARENT=PROVIDER+'\nextern int exercise(void); int run(void) {return exercise();}\n'
HARNESS=r'''
#include <dlfcn.h>
#include <ltdl.h>
#include <stdio.h>
#include <string.h>
int main(int argc,char **argv) {
 if(argc!=3)return 99;
 int fail=!strcmp(argv[1],"alone")||!strcmp(argv[1],"unrelated-local");
 if(!strncmp(argv[1],"unrelated-",10))
  if(!dlopen("./unrelated.so",RTLD_NOW|(!strcmp(argv[1],"unrelated-global")?RTLD_GLOBAL:RTLD_LOCAL)))return 98;
 void *h;
 if(!strcmp(argv[1],"ltdl")) {
  if(lt_dlinit())return 97;
  h=lt_dlopenext(argv[2]);
  if(!h){fprintf(stderr,"%s\n",lt_dlerror());return 96;}
  int (*f)(void)=(int(*)(void))lt_dlsym(h,"run");
  return !f||f()!=42;
 }
 h=dlopen(argv[2],RTLD_NOW|(!strcmp(argv[1],"global")?RTLD_GLOBAL:RTLD_LOCAL));
 if(!h){fprintf(stderr,"%s\n",dlerror());return fail?0:95;}
 if(fail)return 94;
 const char *entry=!strncmp(argv[1],"unrelated-",10)?"exercise":"run";
 int (*f)(void)=(int(*)(void))dlsym(h,entry);
 return !f||f()!=42;
}
'''
def main():
 cc=os.environ.get('CC','cc');results=[]
 with tempfile.TemporaryDirectory(prefix='pa-scope-') as temp:
  p=Path(temp)
  for name,text in [('helper.c',HELPER),('parent.c',PARENT),('provider.c',PROVIDER),('harness.c',HARNESS)]: (p/name).write_text(text)
  def run(args):return subprocess.run(args,cwd=p,text=True,capture_output=True)
  commands=[
   [cc,'-shared','-fPIC','helper.c','-Wl,-soname,helper.so','-Wl,-z,now,-z,nodelete','-o','helper.so'],
   [cc,'-shared','-fPIC','parent.c','-L.','-Wl,--no-as-needed','-l:helper.so','-Wl,-rpath,$ORIGIN','-Wl,-z,now','-o','parent.so'],
   [cc,'-shared','-fPIC','provider.c','-o','unrelated.so'],
   [cc,'harness.c','-ldl','-lltdl','-o','harness']]
  for cmd in commands:
   r=run(cmd)
   if r.returncode:raise RuntimeError(r.stderr)
  for mode,obj in [('alone','./helper.so'),('local','./parent.so'),('global','./parent.so'),('unrelated-local','./helper.so'),('unrelated-global','./helper.so'),('ltdl','./parent')]:
   r=run(['./harness',mode,obj]);results.append({'case':mode,'pass':r.returncode==0,'exitCode':r.returncode,'diagnostic':r.stderr.strip()})
  compiler=run([cc,'--version']).stdout.splitlines()[0]
 report={'scope':'synthetic host ELF graph, NOT Android qualification','platform':platform.platform(),'compiler':compiler,'cases':results,'passed':sum(x['pass'] for x in results),'total':len(results),'android':'NOT_RUN','productionAllowed':False}
 print(json.dumps(report,indent=2));return 0 if all(x['pass'] for x in results) else 1
if __name__=='__main__':raise SystemExit(main())
