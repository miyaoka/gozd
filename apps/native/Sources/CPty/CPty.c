#include "CPty.h"

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
        return -1;
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
        // forkpty が内部で呼んでいるのと同じ標準ヘルパー。
        login_tty(slave);

        if (cwd != NULL) {
            (void)chdir(cwd);
        }
        execve(executable, argv, envp);
        _exit(127);
    }

    // parent
    *out_master = master;
    *out_slave = slave;
    *out_pid = pid;
    return 0;
}
