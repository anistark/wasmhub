#pragma once
/* Stub termios.h for WASI — terminal control is unavailable in WASI Preview 1. */

typedef unsigned int tcflag_t;
typedef unsigned char cc_t;
typedef unsigned int speed_t;

#define NCCS 32
struct termios {
    tcflag_t c_iflag;
    tcflag_t c_oflag;
    tcflag_t c_cflag;
    tcflag_t c_lflag;
    cc_t     c_line;
    cc_t     c_cc[NCCS];
};

/* c_iflag */
#define IGNBRK  0x00000001
#define BRKINT  0x00000002
#define IGNPAR  0x00000004
#define PARMRK  0x00000008
#define INPCK   0x00000010
#define ISTRIP  0x00000020
#define INLCR   0x00000040
#define IGNCR   0x00000080
#define ICRNL   0x00000100
#define IUCLC   0x00000200
#define IXON    0x00000400
#define IXANY   0x00000800
#define IXOFF   0x00001000
#define IMAXBEL 0x00002000

/* c_oflag */
#define OPOST   0x00000001
#define OLCUC   0x00000002
#define ONLCR   0x00000004
#define OCRNL   0x00000008
#define ONOCR   0x00000010
#define ONLRET  0x00000020

/* c_cflag */
#define CS5     0x00000000
#define CS6     0x00000010
#define CS7     0x00000020
#define CS8     0x00000030
#define CSIZE   0x00000030
#define CSTOPB  0x00000040
#define CREAD   0x00000080
#define PARENB  0x00000100
#define PARODD  0x00000200
#define HUPCL   0x00000400
#define CLOCAL  0x00000800

/* c_lflag */
#define ISIG    0x00000001
#define ICANON  0x00000002
#define ECHO    0x00000008
#define ECHOE   0x00000010
#define ECHOK   0x00000020
#define ECHONL  0x00000040
#define NOFLSH  0x00000080
#define TOSTOP  0x00000100
#define IEXTEN  0x00008000

/* c_cc indices */
#define VINTR   0
#define VQUIT   1
#define VERASE  2
#define VKILL   3
#define VEOF    4
#define VTIME   5
#define VMIN    6
#define VSWTC   7
#define VSTART  8
#define VSTOP   9
#define VSUSP   10
#define VEOL    11
#define VREPRINT 12
#define VDISCARD 13
#define VWERASE  14
#define VLNEXT   15
#define VEOL2    16

/* tcsetattr actions */
#define TCSANOW   0
#define TCSADRAIN 1
#define TCSAFLUSH 2

/* baud rates */
#define B0     0x00000000
#define B9600  0x0000000d
#define B115200 0x00001002

static inline int tcgetattr(int fd, struct termios *t)
{ (void)fd; (void)t; return -1; }

static inline int tcsetattr(int fd, int action, const struct termios *t)
{ (void)fd; (void)action; (void)t; return -1; }

static inline speed_t cfgetispeed(const struct termios *t) { (void)t; return B9600; }
static inline speed_t cfgetospeed(const struct termios *t) { (void)t; return B9600; }
static inline int cfsetispeed(struct termios *t, speed_t s) { (void)t; (void)s; return 0; }
static inline int cfsetospeed(struct termios *t, speed_t s) { (void)t; (void)s; return 0; }
