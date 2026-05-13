/*
 * Link-time stubs for symbols that WASI Preview 1 headers declare but
 * don't implement. Compiled to a WASM object and linked alongside QuickJS.
 *
 * pthread stubs: libpthread.a in the WASI SDK is empty (header-only shim).
 * tmpfile stub:  declared deprecated in WASI stdio.h but not in any library.
 */

#include <pthread.h>
#include <stdio.h>
#include <time.h>
#include <errno.h>

/* ── pthread ──────────────────────────────────────────────────────────────── */

int pthread_mutex_init(pthread_mutex_t *m, const pthread_mutexattr_t *a)
{ (void)m; (void)a; return 0; }

int pthread_mutex_destroy(pthread_mutex_t *m) { (void)m; return 0; }
int pthread_mutex_lock(pthread_mutex_t *m)    { (void)m; return 0; }
int pthread_mutex_trylock(pthread_mutex_t *m) { (void)m; return 0; }
int pthread_mutex_unlock(pthread_mutex_t *m)  { (void)m; return 0; }

int pthread_mutexattr_init(pthread_mutexattr_t *a)    { (void)a; return 0; }
int pthread_mutexattr_destroy(pthread_mutexattr_t *a) { (void)a; return 0; }
int pthread_mutexattr_settype(pthread_mutexattr_t *a, int t) { (void)a; (void)t; return 0; }

int pthread_cond_init(pthread_cond_t *c, const pthread_condattr_t *a)
{ (void)c; (void)a; return 0; }

int pthread_cond_destroy(pthread_cond_t *c) { (void)c; return 0; }
int pthread_cond_signal(pthread_cond_t *c)  { (void)c; return 0; }
int pthread_cond_broadcast(pthread_cond_t *c) { (void)c; return 0; }

int pthread_cond_wait(pthread_cond_t *c, pthread_mutex_t *m)
{ (void)c; (void)m; return 0; }

int pthread_cond_timedwait(pthread_cond_t *c, pthread_mutex_t *m,
                           const struct timespec *ts)
{ (void)c; (void)m; (void)ts; return 0; }

/* ── tmpfile ─────────────────────────────────────────────────────────────── */

FILE *tmpfile(void) { errno = ENOSYS; return NULL; }
