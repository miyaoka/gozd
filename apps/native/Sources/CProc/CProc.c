#include "CProc.h"

#include <libproc.h>
#include <sys/proc_info.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>

// proc_listpids で全 pid を取得して malloc 配列に詰める。
// 成功時は *out_pids / *out_count を埋めて 0、失敗時は -1 を返す。
// caller は *out_pids を free する責務を持つ。
static int collect_all_pids(pid_t **out_pids, int *out_count) {
    // 必要バイト数を問い合わせる。
    int bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
    if (bytes <= 0) {
        return -1;
    }
    // プロセスは走査中に増減し得るので少し余裕を持たせる。
    int slots = (bytes / (int)sizeof(pid_t)) + 64;
    pid_t *pids = (pid_t *)calloc((size_t)slots, sizeof(pid_t));
    if (pids == NULL) {
        return -1;
    }
    int got = proc_listpids(PROC_ALL_PIDS, 0, pids, (int)(slots * (int)sizeof(pid_t)));
    if (got <= 0) {
        free(pids);
        return -1;
    }
    *out_pids = pids;
    *out_count = got / (int)sizeof(pid_t);
    return 0;
}

int gozd_list_procs(GozdProcEntry *out, int capacity) {
    pid_t *pids = NULL;
    int count = 0;
    if (collect_all_pids(&pids, &count) != 0) {
        return -1;
    }

    int total = 0;
    for (int i = 0; i < count; i++) {
        pid_t pid = pids[i];
        if (pid <= 0) {
            continue;
        }
        struct proc_bsdinfo info;
        int n = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, PROC_PIDTBSDINFO_SIZE);
        if (n < (int)sizeof(info)) {
            // 取得失敗（終了済み / EPERM 等）は skip。
            continue;
        }
        if (out != NULL && total < capacity) {
            out[total].pid = (int32_t)pid;
            out[total].ppid = (int32_t)info.pbi_ppid;
            // pbi_name は longer name（最大 2*MAXCOMLEN）、空なら pbi_comm にフォールバック。
            const char *name = info.pbi_name[0] != '\0' ? info.pbi_name : info.pbi_comm;
            strlcpy(out[total].name, name, sizeof(out[total].name));
        }
        total++;
    }

    free(pids);
    return total;
}

// 1 プロセスの全 fd を走査し、TCP LISTEN ソケットの port を out に詰める。
// 戻り値はそのプロセスで検出した LISTEN ソケット件数（truncate 込みの total）。
static int collect_listen_ports_for_pid(
    pid_t pid, GozdListenEntry *out, int capacity, int total
) {
    // fd リストの必要バイト数を問い合わせる。
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (bytes <= 0) {
        // EPERM（他ユーザー） / プロセス終了 等。skip。
        return total;
    }
    int slots = (bytes / (int)sizeof(struct proc_fdinfo)) + 16;
    struct proc_fdinfo *fds =
        (struct proc_fdinfo *)calloc((size_t)slots, sizeof(struct proc_fdinfo));
    if (fds == NULL) {
        return total;
    }
    int got = proc_pidinfo(
        pid, PROC_PIDLISTFDS, 0, fds, (int)(slots * (int)sizeof(struct proc_fdinfo)));
    if (got <= 0) {
        free(fds);
        return total;
    }
    int fd_count = got / (int)sizeof(struct proc_fdinfo);
    for (int i = 0; i < fd_count; i++) {
        if (fds[i].proc_fdtype != PROX_FDTYPE_SOCKET) {
            continue;
        }
        struct socket_fdinfo si;
        int n = proc_pidfdinfo(
            pid, fds[i].proc_fd, PROC_PIDFDSOCKETINFO, &si, PROC_PIDFDSOCKETINFO_SIZE);
        if (n < (int)sizeof(si)) {
            continue;
        }
        // TCP 以外（UDP / Unix domain 等）は対象外。
        if (si.psi.soi_kind != SOCKINFO_TCP) {
            continue;
        }
        struct tcp_sockinfo *tcp = &si.psi.soi_proto.pri_tcp;
        // LISTEN 状態のソケットだけを拾う。
        if (tcp->tcpsi_state != TSI_S_LISTEN) {
            continue;
        }
        // insi_lport は network byte order。ntohs で host order に直す。
        uint16_t port = (uint16_t)ntohs((uint16_t)tcp->tcpsi_ini.insi_lport);
        if (port == 0) {
            continue;
        }
        if (out != NULL && total < capacity) {
            out[total].pid = (int32_t)pid;
            out[total].port = port;
        }
        total++;
    }
    free(fds);
    return total;
}

int gozd_list_listen_ports(GozdListenEntry *out, int capacity) {
    pid_t *pids = NULL;
    int count = 0;
    if (collect_all_pids(&pids, &count) != 0) {
        return -1;
    }

    int total = 0;
    for (int i = 0; i < count; i++) {
        pid_t pid = pids[i];
        if (pid <= 0) {
            continue;
        }
        total = collect_listen_ports_for_pid(pid, out, capacity, total);
    }

    free(pids);
    return total;
}
