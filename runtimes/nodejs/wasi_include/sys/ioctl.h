#pragma once
/* Stub sys/ioctl.h for WASI — ioctl is unavailable in WASI Preview 1. */

struct winsize {
    unsigned short ws_row;
    unsigned short ws_col;
    unsigned short ws_xpixel;
    unsigned short ws_ypixel;
};

#define TIOCGWINSZ 0x5413
#define TIOCSWINSZ 0x5414

static inline int ioctl(int fd, unsigned long request, ...)
{ (void)fd; (void)request; return -1; }
