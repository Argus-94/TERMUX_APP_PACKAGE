/* Read-only loader probe; does not call pa__init or audio functions.
 * Compile with the pinned NDK: aarch64-linux-android24-clang -O2 -Wall -Wextra
 *   android-module-loader-probe.c -ldl -o android-module-loader-probe
 * Run ONLY as the target application's UID, with its real PREFIX/environment.
 * A PASS proves this process's relocation/provider context, not full runtime.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int same_file(const char *a, const char *b) {
    struct stat x,y;
    return !stat(a,&x) && !stat(b,&y) && x.st_dev==y.st_dev && x.st_ino==y.st_ino;
}
int main(int argc,char **argv) {
    if (argc!=2 || argv[1][0]!='/') {
        fprintf(stderr,"usage: %s /absolute/path/module-echo-cancel.so\n",argv[0]);
        return 64;
    }
    const char *expected="/data/user/0/com.karat.aibuilder/files/usr/lib/pulseaudio/modules/module-echo-cancel.so";
    struct stat app;
    if (strcmp(argv[1],expected) || getuid()<10000 ||
        stat("/data/user/0/com.karat.aibuilder",&app) ||
        !S_ISDIR(app.st_mode) || app.st_uid!=getuid()) {
        fputs("BLOCKED: module path or target application directory owner UID mismatch\n",stderr);
        return 65;
    }
    printf("uid=%lu module=%s\n",(unsigned long)getuid(),argv[1]);
    void *h=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if (!h) {fprintf(stderr,"DLOPEN_FAIL: %s\n",dlerror());return 1;}
    const char *names[]={"pa_echo_canceller_get_capture_volume","pa_echo_canceller_set_capture_volume"};
    for (unsigned i=0;i<sizeof(names)/sizeof(names[0]);i++) {
        dlerror();
        void *p=dlsym(h,names[i]);
        const char *error=dlerror();
        if (error || !p) {fprintf(stderr,"DLSYM_FAIL %s: %s\n",names[i],error?error:"NULL");return 2;}
        Dl_info info;
        if (!dladdr(p,&info) || !info.dli_fname || !same_file(info.dli_fname,argv[1])) {
            fprintf(stderr,"PROVIDER_MISMATCH %s\n",names[i]);return 3;
        }
        printf("symbol=%s provider=%s\n",names[i],info.dli_fname);
    }
    puts("PASS: RTLD_NOW parent group and both exact symbol providers; not audio/runtime qualification");
    dlclose(h);
    return 0;
}
