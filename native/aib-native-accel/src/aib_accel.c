/**
 * aib_accel — open path-map helper for AI Builder userspace (plan Phase G).
 * License: MIT
 *
 * Pure C, no proprietary code. Optional JNI glue loads this as libaibaccel.so.
 */
#include <string.h>
#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Replace prefix `from` with `to` at start of path. Returns heap string (caller frees) or NULL. */
char *aib_map_path(const char *path, const char *from, const char *to) {
  if (!path || !from || !to) return NULL;
  size_t fl = strlen(from);
  size_t pl = strlen(path);
  if (fl == 0 || pl < fl) {
    char *copy = (char *)malloc(pl + 1);
    if (!copy) return NULL;
    memcpy(copy, path, pl + 1);
    return copy;
  }
  if (strncmp(path, from, fl) != 0) {
    char *copy = (char *)malloc(pl + 1);
    if (!copy) return NULL;
    memcpy(copy, path, pl + 1);
    return copy;
  }
  size_t tl = strlen(to);
  size_t out_len = tl + (pl - fl);
  char *out = (char *)malloc(out_len + 1);
  if (!out) return NULL;
  memcpy(out, to, tl);
  memcpy(out + tl, path + fl, pl - fl);
  out[out_len] = '\0';
  return out;
}

/** Simple version string for probe. */
const char *aib_accel_version(void) {
  return "1.0.0-mit";
}

#ifdef __cplusplus
}
#endif
