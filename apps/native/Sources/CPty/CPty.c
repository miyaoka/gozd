#include "CPty.h"
#include <errno.h>

int gozd_pty_spawn(
    int *out_master,
    int *out_slave,
    pid_t *out_pid,
    struct winsize *winsize_p,
    const char *executable,
    char *const argv[],
    char *const envp[],
    const char *cwd
) {
    int master = -1;
    int slave = -1;
    if (openpty(&master, &slave, NULL, NULL, winsize_p) == -1) {
        return -1;
    }

    pid_t pid = fork();
    if (pid == -1) {
        int err = errno;
        close(master);
        close(slave);
        errno = err;
        return -2;
    }

    if (pid == 0) {
        // child: async-signal-safe な C 呼び出しのみ。
        //
        // signal mask / disposition のクリーンアップ:
        //
        // - sigprocmask: 親が block している signal は execve を超えて子に継承され、
        //   子側で SIG_DFL にしても delivery されない。swift test ランナーや
        //   libdispatch worker は SIGHUP 等を block しているため明示的に空 mask に
        //   戻さないと kill(SIGHUP) が効かない（spike で検証）。
        // - signal(SIG_DFL): 親が SIG_IGN している signal も子側で default に戻す。
        sigset_t empty_mask;
        sigemptyset(&empty_mask);
        sigprocmask(SIG_SETMASK, &empty_mask, NULL);

        signal(SIGHUP, SIG_DFL);
        signal(SIGINT, SIG_DFL);
        signal(SIGQUIT, SIG_DFL);
        signal(SIGTERM, SIG_DFL);
        signal(SIGPIPE, SIG_DFL);
        signal(SIGCHLD, SIG_DFL);

        // 子側で master を閉じる。child は slave 側だけ持つ。
        close(master);
        // setsid + TIOCSCTTY + dup2(slave, 0/1/2) + close(slave > 2) を 1 呼び出しで行う。
        // forkpty が内部で呼んでいるのと同じ標準ヘルパー。失敗時は親が
        // PTYExitReason.exited(code: 125) として観測できるよう専用 exit code で抜ける。
        if (login_tty(slave) == -1) {
            _exit(125);
        }

        if (cwd != NULL) {
            // chdir 失敗（権限なし / ENOENT / symlink 切れ等）を silent に握り潰すと、
            // 子は親の cwd か `/` で execve に進み production で「想定外のディレクトリ
            // で claude が起動して別 repo を見る」等の症状が出るが原因が観測できなく
            // なる。専用 exit code で親に伝える。
            if (chdir(cwd) != 0) {
                _exit(124);
            }
        }
        execve(executable, argv, envp);
        // execve 失敗時は errno に応じて POSIX shell 慣例の exit code に倒す。
        // 親は exit code から失敗 syscall + 大まかな errno を判別できる。
        switch (errno) {
            case EACCES:
                _exit(126);
            case ENOENT:
                _exit(127);
            default:
                _exit(123);
        }
    }

    // parent
    *out_master = master;
    *out_slave = slave;
    *out_pid = pid;
    return 0;
}
