#include "CPty.h"
#include <errno.h>

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
) {
    // ready pipe を openpty / fork より先に作る。失敗時の cleanup を最も小さく抑える。
    // ready_pipe[0]: 親側 read fd ( awaitReady で blocking read )。
    // ready_pipe[1]: 子側 write fd ( execve 直前に 1 byte 書く / _exit で kernel が close )。
    int ready_pipe[2] = { -1, -1 };
    if (pipe(ready_pipe) == -1) {
        return -3;
    }

    int master = -1;
    int slave = -1;
    if (openpty(&master, &slave, NULL, NULL, winsize_p) == -1) {
        int err = errno;
        close(ready_pipe[0]);
        close(ready_pipe[1]);
        errno = err;
        return -1;
    }

    pid_t pid = fork();
    if (pid == -1) {
        int err = errno;
        close(master);
        close(slave);
        close(ready_pipe[0]);
        close(ready_pipe[1]);
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

        // 親側 read fd は子で不要。close しないと親がもし read fd を close してもこの
        // 子が write fd を持っている限り EOF が来ない race を残す。
        close(ready_pipe[0]);

        // 子側で master を閉じる。child は slave 側だけ持つ。
        close(master);
        // setsid + TIOCSCTTY + dup2(slave, 0/1/2) + close(slave > 2) を 1 呼び出しで行う。
        // forkpty が内部で呼んでいるのと同じ標準ヘルパー。失敗時は親が
        // PTYExitReason.exited(code: 125) として観測できるよう専用 exit code で抜ける。
        // _exit 時 kernel が ready_pipe[1] を閉じるため親 read は EOF を観測する
        // ( execve 段階に到達しなかったことが ready pipe + waitpid 経由で判別可能 )。
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

        // execve 直前に ready barrier を立てる。1 byte 書いて close すると親 read が
        // 1 byte を観測し「子は tty setup 完了 + execve 段階に到達」を確定できる。
        // partial write / EINTR 対策で retry loop を組む ( fork 後の child では
        // async-signal-safe な write のみ呼ぶ )。
        const char ready_byte = 'R';
        ssize_t w;
        do {
            w = write(ready_pipe[1], &ready_byte, 1);
        } while (w == -1 && errno == EINTR);
        close(ready_pipe[1]);

        execve(executable, argv, envp);
        // execve 失敗時は errno に応じて POSIX shell 慣例の exit code に倒す。
        // 親は exit code から失敗 syscall + 大まかな errno を判別できる。
        // ( ready byte は既に書かれているので親 read は 1 byte 受信 → 直後 waitpid で
        //   exit code が回収される。awaitReady だけでは execve 失敗を区別できないが、
        //   onExit 配送経路で reason が届くので test 側はそちらを観測する。)
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
    // 親側 write fd は不要。close しないと子が execve / _exit しても親 process が
    // write fd を 1 reference 持つため EOF が永久に来ず awaitReady が hang する。
    close(ready_pipe[1]);

    *out_master = master;
    *out_slave = slave;
    *out_pid = pid;
    *out_ready_read_fd = ready_pipe[0];
    return 0;
}
