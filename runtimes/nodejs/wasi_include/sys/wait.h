#pragma once
/* Stub sys/wait.h for WASI — process waiting is unavailable in WASI Preview 1. */
#include <sys/types.h>

#define WIFEXITED(s)   (((s) & 0x7f) == 0)
#define WEXITSTATUS(s) (((s) >> 8) & 0xff)
#define WIFSIGNALED(s) (((s) & 0x7f) != 0 && ((s) & 0x7f) != 0x7f)
#define WTERMSIG(s)    ((s) & 0x7f)
#define WIFSTOPPED(s)  (((s) & 0xff) == 0x7f)
#define WSTOPSIG(s)    (((s) >> 8) & 0xff)
#define WIFCONTINUED(s) ((s) == 0xffff)

#define WNOHANG   1
#define WUNTRACED 2
