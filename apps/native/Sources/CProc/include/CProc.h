#ifndef CProc_h
#define CProc_h

#include <stdint.h>

// libproc を使ったプロセス情報 / TCP LISTEN ソケット列挙の C bridge（issue #768）。
//
// 設計理由:
//
// 1. macOS にはソケットの LISTEN 開始を通知する event API が無いため、サーバー検出は
//    ポーリングで全プロセスの fd を走査する構成になる。`proc_listpids` /
//    `proc_pidinfo(PROC_PIDTBSDINFO)` / `proc_pidfdinfo(PROC_PIDFDSOCKETINFO)` を使う。
//
// 2. `socket_fdinfo` は C union（`psi.soi_proto.pri_tcp` 等）を多用するため、Swift の
//    C union import 経由で触ると煩雑になる。必要な値（pid / port / ppid / name）だけを
//    C 側で抽出して plain な struct 配列で返し、Swift 側は普通の配列として扱う。
//
// 3. `proc_pidfdinfo` / `PROC_PIDLISTFDS` は他ユーザー所有プロセスに対し EPERM を返す。
//    本 bridge が列挙できるのは実質「現在ユーザー所有プロセスの LISTEN ソケット」。
//    dev server は基本ユーザー所有なので port 競合調査の主目的には十分。EPERM は
//    そのプロセスを skip して走査を続ける（全体を失敗させない）。

// 単一プロセスの基本情報。
typedef struct {
    int32_t pid;
    int32_t ppid;
    // プロセス名（comm）。libproc が返すのは最大 MAXCOMLEN(16) 程度だが余裕を持たせる。
    char name[256];
} GozdProcEntry;

// 単一の TCP LISTEN ソケット。
typedef struct {
    int32_t pid;
    uint16_t port;
} GozdListenEntry;

// 全プロセスの pid/ppid/name を列挙する。
//
// - out == NULL または capacity <= 0 のときは「必要な要素数」だけ返す（probe 用）。
// - それ以外は min(total, capacity) 件を out に書き、total を返す。
//   total > capacity なら truncate されているので caller は再試行できる。
// - libproc の致命的失敗時は -1。
int gozd_list_procs(GozdProcEntry *out, int capacity);

// 全 TCP LISTEN ソケットの pid/port を列挙する。
//
// - min(total, capacity) 件を out に書き、検出した total 件数を返す。
// - total > capacity なら truncate（caller が capacity を増やして再試行可能）。
// - libproc の致命的失敗時は -1。個別プロセスの EPERM 等は skip して継続する。
int gozd_list_listen_ports(GozdListenEntry *out, int capacity);

#endif
