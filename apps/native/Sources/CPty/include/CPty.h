#ifndef CPty_h
#define CPty_h

#include <util.h>
#include <termios.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <signal.h>
#include <stdlib.h>

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
// 5. **ready pipe ( 親←子 ) で execve barrier を立てる**。子は login_tty / chdir
//    完了後、execve 直前に 1 byte 書き、close する。親側は `out_ready_read_fd` を
//    blocking read することで「子が ready byte を書く段階まで到達した」ことを確認できる:
//      - read が 1 byte ('R') を返した: 子は login_tty / chdir 完了 → execve に進んだ
//        ( execve 自体の成功 / 失敗は本 barrier では識別しない。失敗した場合も ready byte
//        は既に書かれており、親 read は 1 byte を受け取る。execve 失敗 ( exit code
//        123 / 126 / 127 ) は後段の `onExit` 経路で配送される )
//      - read が 0 byte (EOF) を返した: 子は ready byte を書く前に _exit した
//        ( login_tty 失敗 → exit 125、chdir 失敗 → exit 124 のいずれか )。kernel が
//        _exit で write fd を閉じる経路
//    親側 `awaitReady()` で 1 度だけ read + close する責務を持つ ( PTYManager.swift )。
//
// 戻り値:
//   - 0: 成功。out_master / out_slave / out_pid / out_ready_read_fd に値が入る。
//   - -1: openpty 失敗（errno が set される）。
//   - -2: fork 失敗（errno が set される）。
//   - -3: ready pipe 作成失敗（errno が set される）。
//
// 親プロセスは戻り値で openpty / fork / pipe のどれが失敗したかを区別できる。errno
// のみでは EAGAIN を openpty / fork / pipe いずれも返し得るため、syscall を取り違える。
//
// child 側で setup に失敗した場合は execve まで到達せず以下の exit code で抜ける。
// 親は `PTYExitReason.exited(code: N)` から失敗段階を判別できる:
//
//   - 123: execve 失敗（EACCES / ENOENT 以外の errno、例: E2BIG / ENOEXEC）。
//   - 124: chdir 失敗（指定 cwd へ移れない: 権限・存在しない・symlink 切れ等）。
//   - 125: login_tty 失敗（PTY セットアップ失敗: setsid / TIOCSCTTY / dup2）。
//   - 126: execve EACCES（POSIX 慣例: not executable）。
//   - 127: execve ENOENT（POSIX 慣例: command not found）。
int gozd_pty_spawn(
    int *out_master,
    int *out_slave,
    pid_t *out_pid,
    int *out_ready_read_fd,
    struct winsize *winsize_p,
    const char *executable,
    char *const argv[],
    char *const envp[],
    const char *cwd
);

#endif
