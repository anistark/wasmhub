#pragma once
/*
 * Inline stubs for POSIX functions unavailable in WASI Preview 1.
 * Injected via -include at compile time; never modifies QuickJS source.
 */
#ifdef __wasi__
#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <sys/types.h>

/* WASI sysroot may not ship sys/wait.h macros */
#ifndef WIFEXITED
#define WIFEXITED(s)   (((s) & 0x7f) == 0)
#define WEXITSTATUS(s) (((s) >> 8) & 0xff)
#define WIFSIGNALED(s) (((s) & 0x7f) != 0 && ((s) & 0x7f) != 0x7f)
#define WTERMSIG(s)    ((s) & 0x7f)
#define WIFSTOPPED(s)  (((s) & 0xff) == 0x7f)
#define WSTOPSIG(s)    (((s) >> 8) & 0xff)
#endif

/* malloc_usable_size is a glibc extension; stub it as 0 for WASI */
static inline size_t malloc_usable_size(void *ptr) { (void)ptr; return 0; }

/* FE_DOWNWARD/FE_UPWARD: IEEE 754 directed rounding modes.
 * WASM has no dynamic rounding mode support; define the constants so
 * QuickJS's float-to-string code compiles. Grisu3 will fall back to
 * the nearest-even path when fesetround() is a no-op. */
#include <fenv.h>
#ifndef FE_DOWNWARD
#define FE_DOWNWARD   0x0400
#endif
#ifndef FE_UPWARD
#define FE_UPWARD     0x0800
#endif
#ifndef FE_TOWARDZERO
#define FE_TOWARDZERO 0x0c00
#endif

static inline FILE *popen(const char *cmd, const char *mode)
{ (void)cmd; (void)mode; errno = ENOSYS; return NULL; }

static inline int pclose(FILE *f)
{ (void)f; return 0; }

static inline int setenv(const char *name, const char *value, int overwrite)
{ (void)name; (void)value; (void)overwrite; return 0; }

static inline int unsetenv(const char *name)
{ (void)name; return 0; }

static inline pid_t fork(void)
{ errno = ENOSYS; return (pid_t)-1; }

static inline int execv(const char *path, char *const argv[])
{ (void)path; (void)argv; errno = ENOSYS; return -1; }

static inline int execve(const char *path, char *const argv[], char *const envp[])
{ (void)path; (void)argv; (void)envp; errno = ENOSYS; return -1; }

static inline int execvp(const char *file, char *const argv[])
{ (void)file; (void)argv; errno = ENOSYS; return -1; }

static inline pid_t waitpid(pid_t pid, int *status, int options)
{ (void)pid; (void)options; if (status) *status = 0; errno = ENOSYS; return (pid_t)-1; }

/* environ: wasi-libc provides the variable but some headers don't re-export it */
extern char **environ;

/* Unix fd/process primitives used by quickjs-libc os.* bindings */
static inline int pipe(int fds[2]) { (void)fds; errno = ENOSYS; return -1; }
static inline int dup(int fd) { (void)fd; errno = ENOSYS; return -1; }
static inline int dup2(int oldfd, int newfd) { (void)oldfd; (void)newfd; errno = ENOSYS; return -1; }
static inline int kill(pid_t pid, int sig) { (void)pid; (void)sig; errno = ENOSYS; return -1; }
static inline int setuid(uid_t uid) { (void)uid; errno = ENOSYS; return -1; }
static inline int setgid(gid_t gid) { (void)gid; errno = ENOSYS; return -1; }

/* sighandler_t: GNU typedef not present in WASI's signal.h */
#include <signal.h>
#ifndef _SIGHANDLER_T
typedef void (*sighandler_t)(int);
#define _SIGHANDLER_T 1
#endif

#endif /* __wasi__ */
