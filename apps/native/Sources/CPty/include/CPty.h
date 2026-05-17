#ifndef CPty_h
#define CPty_h

#include <util.h>
#include <termios.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <signal.h>
#include <stdlib.h>
#include <errno.h>

// openpty + fork + login_tty + execve を 1 関数にまとめた wrapper（issue #544）。
//
// 設計理由:
//
// 1. `fork(2)` は Darwin SDK で Swift から直接呼べない（unavailable とマークされている）。
//    `forkpty(3)` は呼べるが、それを使うと「親側に slave fd を保持しない」設計になり、
//    macOS xnu の tty driver の flush-on-close race（issue #544 / 過去 issue #450）で
//    短命 child の最終出力が drop する。よって C bridge 経由で fork を呼ぶしかない。
//
// 2. 子側コードを C に隔離することで、Swift runtime / ARC に触れる可能性をゼロにする。
//    fork 後の子側で async-signal-safe でない関数を呼ぶと未定義動作になるリスクがある。
//
// 3. `login_tty(3)` で setsid + TIOCSCTTY + dup2(slave, 0/1/2) + close(slave>2) を
//    1 呼び出しで行う。これは forkpty が内部で呼んでいるのと同じ標準ヘルパー。
//
// 4. master fd は親が drain / write に使うため open のまま返す。slave fd も親が
//    保持し続けてアンカーにする（child の `_exit` で tty reference が 0 にならない
//    ようにし、ttyclose → ttyflush で pending output が drop されるのを防ぐ）。
//    drain 完了後に親が明示的に slave を close する責務を持つ。
//
// 戻り値:
//   - 0: 成功。out_master / out_slave / out_pid に値が入る。
//   - -1: 失敗。errno が set される（openpty 失敗 / fork 失敗）。
int gozd_pty_spawn(
    int *out_master,
    int *out_slave,
    pid_t *out_pid,
    struct winsize *winsize_p,
    const char *executable,
    char *const argv[],
    char *const envp[],
    const char *cwd
);

#endif
