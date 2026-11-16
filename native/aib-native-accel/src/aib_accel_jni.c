/**
 * JNI bridge for libaibaccel — MIT
 */
#include <jni.h>
#include <stdlib.h>
#include "aib_accel.h"

JNIEXPORT jstring JNICALL
Java_com_karat_aibuilder_AibAccelNative_version(JNIEnv *env, jclass clazz) {
  (void)clazz;
  return (*env)->NewStringUTF(env, aib_accel_version());
}

JNIEXPORT jstring JNICALL
Java_com_karat_aibuilder_AibAccelNative_mapPath(
    JNIEnv *env, jclass clazz, jstring path, jstring from, jstring to) {
  (void)clazz;
  if (!path || !from || !to) return NULL;
  const char *cpath = (*env)->GetStringUTFChars(env, path, 0);
  const char *cfrom = (*env)->GetStringUTFChars(env, from, 0);
  const char *cto = (*env)->GetStringUTFChars(env, to, 0);
  char *mapped = aib_map_path(cpath, cfrom, cto);
  (*env)->ReleaseStringUTFChars(env, path, cpath);
  (*env)->ReleaseStringUTFChars(env, from, cfrom);
  (*env)->ReleaseStringUTFChars(env, to, cto);
  if (!mapped) return NULL;
  jstring out = (*env)->NewStringUTF(env, mapped);
  free(mapped);
  return out;
}
